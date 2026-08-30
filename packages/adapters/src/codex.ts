import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Codex, type CodexOptions, type Thread, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
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

interface CodexRunState {
  queue: EventQueue<NormalizedEvent>;
  abort: AbortController;
}

export interface CodexAdapterOptions {
  /** Capability-provider label; execution still uses the Codex agent runtime. */
  provider?: string;
  models?: CapabilityManifest["core"]["models"];
  authEnvVars?: string[];
  providerDetail?: Record<string, unknown>;
  codex?: CodexOptions;
}

/**
 * OpenAI Codex adapter over @openai/codex-sdk (JSONL event stream).
 *
 * Honesty notes (verified against SDK 0.149 type declarations):
 * - Usage arrives per-turn via turn.completed — mapped to usage.updated.
 * - This SDK layer exposes NO rate_limits/quota-percent payload, so the
 *   manifest reports reportsLimits: false; limit *hits* are still detected
 *   by error classification and emitted as limit.hit.
 * - No mid-turn input or approval round-trip: runs execute sandboxed
 *   (workspace-write, approvalPolicy "never"); supportsMidRunInput: false.
 */
export class CodexAdapter implements AgentAdapter {
  private codex: Codex;
  private runs = new Map<string, CodexRunState>();

  constructor(readonly id: AssistantId, private options: CodexAdapterOptions = {}) {
    this.codex = new Codex(options.codex);
  }

  async describe(): Promise<CapabilityManifest> {
    return {
      assistantId: this.id,
      provider: this.options.provider ?? "openai",
      core: {
        models: this.options.models ?? [{ id: "default", displayName: "Codex default (CLI-configured)" }],
        canResume: true, // resumeThread(threadId); threads persisted in ~/.codex/sessions
        canMcp: true,
        supportsMidRunInput: false,
        reportsUsage: true,
        reportsLimits: false, // no quota-% payload at this SDK layer; limit hits via error classification
        execution: { shell: true, filesystem: true, web: "unknown" },
        auth: detectAuth(this.options.authEnvVars),
      },
      providerDetail: {
        runtime: "@openai/codex-sdk",
        sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
        approvalPolicies: ["never", "on-request", "on-failure", "untrusted"],
        ...this.options.providerDetail,
      },
      evidence: { source: "local-config", observedAt: new Date().toISOString() },
    };
  }

  async start(run: RunSpec): Promise<RunHandle> {
    const thread = this.codex.startThread(this.threadOptions(run));
    return this.launch(thread, run);
  }

  async resume(ref: ProviderSessionRef, run: RunSpec): Promise<RunHandle> {
    const thread = this.codex.resumeThread(ref, this.threadOptions(run));
    return this.launch(thread, run);
  }

  private threadOptions(run: RunSpec) {
    return {
      workingDirectory: run.workdir,
      model: run.model?.id === "default" ? undefined : run.model?.id,
      sandboxMode: "workspace-write" as const,
      // Sandbox is the safety boundary; interactive approvals are not part of
      // this SDK's typed surface, so escalations are simply unavailable.
      approvalPolicy: "never" as const,
    };
  }

  private async launch(thread: Thread, run: RunSpec): Promise<RunHandle> {
    const runId = newRunId();
    const state: CodexRunState = { queue: new EventQueue<NormalizedEvent>(), abort: new AbortController() };
    this.runs.set(runId, state);
    const handle: RunHandle = { runId, assistantId: this.id };

    void this.pump(runId, handle, thread, run, state);
    return handle;
  }

  private async pump(
    runId: RunId | string,
    handle: RunHandle,
    thread: Thread,
    run: RunSpec,
    state: CodexRunState,
  ): Promise<void> {
    const emit = (e: Omit<NormalizedEvent, "runId" | "ts">) =>
      state.queue.push({ runId: runId as RunId, ts: new Date().toISOString(), ...e });
    let ended = false;
    try {
      const { events } = await thread.runStreamed(run.prompt, { signal: state.abort.signal });
      for await (const event of events) {
        ended = this.mapEvent(event, handle, emit) || ended;
      }
      if (!ended) emit({ type: "run.ended", summary: "Stream closed", payload: { ok: true } });
      state.queue.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (classifyLimit(message)) {
        emit({ type: "limit.hit", summary: `Provider limit: ${truncate(message)}`, raw: { message } });
      }
      emit({ type: "error", summary: truncate(message), raw: { message } });
      emit({ type: "run.ended", summary: "Run ended with error", payload: { ok: false } });
      state.queue.end();
    } finally {
      this.runs.delete(String(runId));
    }
  }

  /** Returns true when the event terminated the run. */
  private mapEvent(
    event: ThreadEvent,
    handle: RunHandle,
    emit: (e: Omit<NormalizedEvent, "runId" | "ts">) => void,
  ): boolean {
    switch (event.type) {
      case "thread.started":
        handle.providerSessionRef = event.thread_id as ProviderSessionRef;
        emit({
          type: "run.started",
          summary: "Codex thread started",
          payload: { providerSessionRef: event.thread_id },
          raw: event,
        });
        return false;
      case "turn.started":
        return false;
      case "item.started":
      case "item.updated": {
        if (event.item.type === "command_execution" && event.type === "item.started") {
          emit({
            type: "tool.started",
            summary: `$ ${truncate(event.item.command, 140)}`,
            payload: { toolUseId: event.item.id, tool: "shell", command: event.item.command },
          });
        }
        return false;
      }
      case "item.completed":
        this.mapItem(event.item, emit);
        return false;
      case "turn.completed":
        emit({
          type: "usage.updated",
          summary: `Tokens in/out: ${event.usage.input_tokens}/${event.usage.output_tokens}`,
          payload: {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens,
          },
          raw: event,
        });
        emit({ type: "run.ended", summary: "Run completed", payload: { ok: true } });
        return true;
      case "turn.failed": {
        const message = event.error.message;
        if (classifyLimit(message)) {
          emit({ type: "limit.hit", summary: `Provider limit: ${truncate(message)}`, raw: event });
        }
        emit({ type: "error", summary: truncate(message), raw: event });
        emit({ type: "run.ended", summary: "Run ended with error", payload: { ok: false } });
        return true;
      }
      case "error": {
        if (classifyLimit(event.message)) {
          emit({ type: "limit.hit", summary: `Provider limit: ${truncate(event.message)}`, raw: event });
        }
        emit({ type: "error", summary: truncate(event.message), raw: event });
        emit({ type: "run.ended", summary: "Run ended with error", payload: { ok: false } });
        return true;
      }
      default:
        return false;
    }
  }

  private mapItem(item: ThreadItem, emit: (e: Omit<NormalizedEvent, "runId" | "ts">) => void): void {
    switch (item.type) {
      case "agent_message":
        emit({ type: "message", summary: truncate(item.text), payload: { text: item.text } });
        return;
      case "reasoning":
        emit({ type: "message", summary: truncate(item.text), payload: { text: item.text, kind: "reasoning" } });
        return;
      case "command_execution":
        emit({
          type: item.status === "failed" ? "tool.failed" : "tool.completed",
          summary: `$ ${truncate(item.command, 100)} → exit ${item.exit_code ?? "?"}`,
          payload: {
            toolUseId: item.id,
            tool: "shell",
            command: item.command,
            exitCode: item.exit_code,
            output: truncate(item.aggregated_output, 2000),
          },
        });
        return;
      case "file_change":
        for (const change of item.changes) {
          emit({
            type: "file.changed",
            summary: `${change.kind} ${change.path}`,
            payload: { path: change.path, kind: change.kind, ok: item.status === "completed" },
          });
        }
        return;
      case "mcp_tool_call":
        emit({
          type: item.status === "failed" ? "tool.failed" : "tool.completed",
          summary: `MCP ${item.server}.${item.tool}`,
          payload: { toolUseId: item.id, tool: `mcp:${item.server}.${item.tool}`, error: item.error?.message },
        });
        return;
      case "error":
        emit({ type: "error", summary: truncate(item.message), payload: { fatal: false } });
        return;
      case "web_search":
      case "todo_list":
        return;
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

function detectAuth(authEnvVars?: string[]): CapabilityManifest["core"]["auth"] {
  if (authEnvVars) {
    const configured = authEnvVars.find((name) => process.env[name]);
    return configured ? { state: "ok", account: `env:${configured}` } : { state: "missing" };
  }
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) {
    return { state: "ok", account: "env-credential" };
  }
  if (existsSync(join(homedir(), ".codex", "auth.json"))) {
    return { state: "ok", account: "codex-cli-login" };
  }
  return { state: "missing" };
}

function classifyLimit(text: string): boolean {
  return /rate.?limit|usage limit|quota|429|too many requests/i.test(text);
}

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
