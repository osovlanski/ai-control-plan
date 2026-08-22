import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  ServiceQuotaExceededException,
  ThrottlingException,
} from "@aws-sdk/client-bedrock-agentcore";
import type {
  AgentAdapter,
  AssistantId,
  CapabilityManifest,
  NormalizedEvent,
  ProviderSessionRef,
  RunHandle,
  RunId,
  RunSpec,
} from "@agent-plane/core";
import { newRunId, NotSupportedError } from "@agent-plane/core";
import { EventQueue } from "./event-queue.js";

export interface BedrockOptions {
  /** ARN of the AgentCore runtime to invoke. Required — Bedrock hosts YOUR agent. */
  agentRuntimeArn?: string;
  qualifier?: string;
  region?: string;
}

interface BedrockRunState {
  queue: EventQueue<NormalizedEvent>;
  abort: AbortController;
}

/**
 * AWS Bedrock AgentCore adapter.
 *
 * Bedrock is a hosting platform, not an assistant: routing "to Bedrock" means
 * invoking a specific agent you have already deployed. So the runtime ARN comes
 * from workspace configuration rather than capability discovery (review §2.4).
 *
 * Verified against @aws-sdk/client-bedrock-agentcore 3.1116 type declarations:
 * - InvokeAgentRuntimeCommand requires { agentRuntimeArn, payload: Uint8Array }
 * - runtimeSessionId appears on BOTH request and response — that is the resume
 *   mechanism, so canResume is true.
 * - response is a streaming blob; contentType says how to read it.
 * - ThrottlingException / ServiceQuotaExceededException are typed, so limit
 *   HITS are detectable — but AWS is metered, not plan-quota'd, so there is no
 *   used-percent to report early. reportsLimits stays false, same honest shape
 *   as the Codex adapter.
 *
 * NOT verified against a live AgentCore deployment: no AWS account was
 * reachable when this was written. The invoke contract comes from the SDK's own
 * types; the *payload shape* is defined by whichever agent you deploy, so
 * mapping below stays deliberately conservative and keeps everything in `raw`.
 */
export class BedrockAdapter implements AgentAdapter {
  private runs = new Map<string, BedrockRunState>();
  private client: BedrockAgentCoreClient;

  constructor(
    readonly id: AssistantId,
    private options: BedrockOptions = {},
  ) {
    this.client = new BedrockAgentCoreClient(options.region ? { region: options.region } : {});
  }

  async describe(): Promise<CapabilityManifest> {
    const configured = Boolean(this.options.agentRuntimeArn);
    return {
      assistantId: this.id,
      provider: "bedrock",
      core: {
        // The model is chosen inside the deployed agent, not by the plane.
        models: [{ id: this.options.qualifier ?? "DEFAULT", displayName: "Deployed AgentCore runtime" }],
        canResume: true, // runtimeSessionId round-trips
        canMcp: true, // the invoke API carries MCP session/protocol fields
        supportsMidRunInput: false, // invoke is request/response per turn
        // What the deployed agent can do is defined by that agent, not
        // discoverable from here. Claiming shell/filesystem would let the
        // router hard-filter on a guess.
        reportsUsage: false,
        reportsLimits: false,
        execution: { shell: false, filesystem: false, web: "unknown" },
        auth: this.detectAuth(configured),
      },
      providerDetail: {
        runtime: "@aws-sdk/client-bedrock-agentcore",
        agentRuntimeArn: this.options.agentRuntimeArn ?? null,
        qualifier: this.options.qualifier ?? null,
        region: this.options.region ?? process.env.AWS_REGION ?? null,
        verifiedAgainstLiveService: false,
      },
      evidence: { source: "local-config", observedAt: new Date().toISOString() },
    };
  }

  private detectAuth(configured: boolean): CapabilityManifest["core"]["auth"] {
    if (!configured) return { state: "missing", account: "no agentRuntimeArn configured" };
    // Deliberately a local check, like the other adapters: describe() must not
    // make a network call on the boot/daily-sync path.
    const hasEnv = Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_ROLE_ARN);
    const hasFile = existsSync(join(homedir(), ".aws", "credentials")) || existsSync(join(homedir(), ".aws", "config"));
    return hasEnv || hasFile
      ? { state: "ok", account: process.env.AWS_PROFILE ?? "aws-credential-chain" }
      : { state: "missing", account: "no AWS credentials found" };
  }

  async start(run: RunSpec): Promise<RunHandle> {
    // AgentCore session ids must be comfortably long; a prefixed UUID clears it.
    return this.launch(run, `agent-plane-${crypto.randomUUID()}${crypto.randomUUID()}` as ProviderSessionRef);
  }

  async resume(ref: ProviderSessionRef, run: RunSpec): Promise<RunHandle> {
    return this.launch(run, ref);
  }

  private async launch(run: RunSpec, sessionId: ProviderSessionRef): Promise<RunHandle> {
    const arn = this.options.agentRuntimeArn;
    if (!arn) throw new NotSupportedError(`${this.id}: agentRuntimeArn is not configured`);

    const runId = newRunId();
    const state: BedrockRunState = { queue: new EventQueue<NormalizedEvent>(), abort: new AbortController() };
    this.runs.set(runId, state);
    const handle: RunHandle = { runId, assistantId: this.id, providerSessionRef: sessionId };

    void this.pump(runId, handle, run, arn, sessionId, state);
    return handle;
  }

  private async pump(
    runId: RunId,
    handle: RunHandle,
    run: RunSpec,
    agentRuntimeArn: string,
    sessionId: ProviderSessionRef,
    state: BedrockRunState,
  ): Promise<void> {
    const emit = (e: Omit<NormalizedEvent, "runId" | "ts">) =>
      state.queue.push({ runId, ts: new Date().toISOString(), ...e });

    emit({
      type: "run.started",
      summary: `Bedrock AgentCore runtime invoked`,
      payload: { providerSessionRef: sessionId, agentRuntimeArn },
    });

    try {
      const response = await this.client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn,
          qualifier: this.options.qualifier,
          runtimeSessionId: sessionId,
          contentType: "application/json",
          accept: "application/json",
          payload: new TextEncoder().encode(JSON.stringify({ prompt: run.prompt, taskId: run.taskId })),
        }),
        { abortSignal: state.abort.signal },
      );

      const body = response.response
        ? await (response.response as { transformToString: (enc?: string) => Promise<string> }).transformToString()
        : "";

      for (const chunk of parseAgentOutput(body, response.contentType)) {
        emit({ type: "message", summary: truncate(chunk), payload: { text: chunk }, raw: chunk });
      }
      emit({ type: "run.ended", summary: "Run completed", payload: { ok: true, statusCode: response.statusCode } });
    } catch (err) {
      // Typed limit errors feed the same failover path as every other provider.
      if (err instanceof ThrottlingException || err instanceof ServiceQuotaExceededException) {
        emit({
          type: "limit.hit",
          summary: `Bedrock limit: ${err.name}`,
          raw: { name: err.name, message: err.message },
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", summary: truncate(message), raw: { message } });
      emit({ type: "run.ended", summary: "Run ended with error", payload: { ok: false } });
    } finally {
      state.queue.end();
      this.runs.delete(runId);
    }
  }

  events(handle: RunHandle): AsyncIterable<NormalizedEvent> {
    const state = this.runs.get(handle.runId);
    if (!state) throw new NotSupportedError(`events for unknown run ${handle.runId}`);
    return state.queue;
  }

  async cancel(handle: RunHandle): Promise<void> {
    this.runs.get(handle.runId)?.abort.abort();
  }
}

/**
 * The response body is whatever the deployed agent returns, so this handles the
 * two shapes AgentCore itself defines — an SSE stream or a single blob — and
 * otherwise passes text through rather than guessing at a schema.
 */
export function parseAgentOutput(body: string, contentType: string | undefined): string[] {
  if (!body.trim()) return [];
  if (contentType?.includes("text/event-stream")) {
    return body
      .split(/\n\n+/)
      .flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data:")))
      .map((line) => line.slice(5).trim())
      .filter((data) => data && data !== "[DONE]");
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "string") return [parsed];
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["output", "result", "completion", "text", "message"]) {
        const value = record[key];
        if (typeof value === "string") return [value];
      }
    }
    return [body];
  } catch {
    return [body];
  }
}

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
