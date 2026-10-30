import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Codex, type CodexOptions, type Thread, type ThreadEvent, type ThreadItem, type Usage } from "@openai/codex-sdk";
import type {
  AgentAdapter,
  ProvisionedProfile,
  ProvisioningInput,
  ProvisioningPlan,
  ProvisioningVerification,
  AssistantId,
  CapabilityManifest,
  NormalizedEvent,
  ProviderSessionRef,
  RunHandle,
  RunId,
  RunSpec,
} from "@agent-plane/core";
import { newRunId, NotSupportedError, ProvisioningError } from "@agent-plane/core";
import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";
import { codexProfileConfig, probeCodexProfile, type CodexProbeRun } from "./codex-probe.js";
import { codexSdkBinary } from "./codex-sdk-binary.js";
import { codexPermissions } from "./codex-permissions.js";
import { EventQueue } from "./event-queue.js";
import { codexProvisioningPlan, disposeProfileDir, materializeProfile, mcpSecretEnv, requireProfileHarness, verifyProfileOnDisk } from "./provisioning.js";

interface CodexRunState {
  queue: EventQueue<NormalizedEvent>;
  abort: AbortController;
  /** The thread this run continues, when it is a resume. */
  resumedThread?: string;
}

/** A `turn.completed` usage figure: at SDK 0.154 the thread's running total, not the turn's. */
interface ThreadTotals { input: number; cached: number; cacheWrite: number; output: number; reasoning: number }

const ZERO_TOTALS: ThreadTotals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };

export interface CodexAdapterOptions {
  /** Capability-provider label; execution still uses the Codex agent runtime. */
  provider?: string;
  models?: CapabilityManifest["core"]["models"];
  authEnvVars?: string[];
  providerDetail?: Record<string, unknown>;
  codex?: CodexOptions;
  /** Explicit execution-transport opt-in; session input still needs a per-session grant. */
  appServerInput?: boolean;
  /**
   * M3 S5b: `verify` also renders the profile with `codex debug prompt-input` and checks the
   * model-visible input carries it. Off by default; needs the Codex binary, not credentials.
   */
  probePromptInput?: boolean;
  /** Test seam for the prompt-input probe's process launch. */
  probeRun?: CodexProbeRun;
}

/**
 * OpenAI Codex adapter over @openai/codex-sdk (JSONL event stream) by default.
 * The opt-in app-server path owns execution and the separate input contract.
 *
 * Honesty notes (verified against SDK 0.149 type declarations):
 * - Usage arrives once per run via turn.completed — mapped to usage.updated. Despite the SDK's
 *   "during the turn" doc, codex exec fills it from the thread's running total
 *   (`usage_from_last_total`, rust-v0.154.0), and a resumed thread is seeded with its earlier
 *   total from the rollout. So the adapter counts the run's share: the total minus the total it
 *   last saw for that thread, or nothing when a resumed thread has no baseline in this process.
 * - This SDK layer exposes NO rate_limits/quota-percent payload, so the
 *   manifest reports reportsLimits: false; limit *hits* are still detected
 *   by error classification and emitted as limit.hit.
 * - No mid-turn input or approval round-trip: runs execute sandboxed with
 *   approvalPolicy "never"; the sandbox follows the workspace approval mode
 *   (codexPermissions) and prompt-on-escalation is refused at start.
 */
export class CodexAdapter implements AgentAdapter {
  private codex: Codex;
  private readonly appServer?: CodexAppServerRuntime;

  get sessionInput() { return this.appServer?.sessionInput; }
  private runs = new Map<string, CodexRunState>();
  /** The last thread total each thread reported in this process: a resume's baseline. */
  private threadTotals = new Map<string, ThreadTotals>();

  constructor(readonly id: AssistantId, private options: CodexAdapterOptions = {}) {
    if (options.appServerInput && options.codex && Object.entries(options.codex).some(([key, value]) => key !== "codexPathOverride" && value !== undefined)) {
      throw new NotSupportedError("custom SDK options on the Codex app-server input transport");
    }
    this.codex = new Codex(options.codex);
    if (options.appServerInput) this.appServer = new CodexAppServerRuntime(id, options.codex?.codexPathOverride);
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
      // M3: the SDK path delivers a profile's instructions but leaves ~/.codex visible
      // (`codexProvisioningPlan`); the app-server transport delivers nothing yet. The other fields
      // are the defaults an absent block already meant, so Prepare decides exactly as before.
      // Usage: the SDK path emits the run's share once, so it is cumulative for the run. The
      // app-server transport keeps the last model request's figure (`tokenUsage.last`), not the
      // turn's, so it stays uncounted. No `usageReporting` contract: a token cap stays advisory.
      harness: { usageAccounting: this.appServer ? "none" : "cumulative", toolGating: "none", approvalRelay: false, processIsolation: "none", provisioning: this.appServer ? "none" : "partial" },
      // M14 K9: `turn.completed` token accounting is NOT established as live
      // context occupancy, and this SDK layer exposes no context-usage payload.
      // App Server `thread/compact/start` + `thread/tokenUsage/updated` exist
      // beyond it; the optional input transport does not enable these controls.
      context: {
        occupancy: "unavailable",
        effectiveWindow: "unavailable",
        compact: "none",
        autoManagement: "provider",
        autoManagementDetail:
          "Codex manages its own context; experimental context management (keeps notes, searches earlier task history) is opt-in and account-dependent. Not observable at this SDK layer.",
        observesAutoCompaction: false,
      },
      providerDetail: {
        runtime: this.appServer ? "codex-app-server" : "@openai/codex-sdk",
        sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
        approvalPolicies: ["never", "on-request", "on-failure", "untrusted"],
        ...this.options.providerDetail,
      },
      evidence: { source: "local-config", observedAt: new Date().toISOString() },
    };
  }

  async start(run: RunSpec): Promise<RunHandle> {
    codexPermissions(run.permissionPolicy); // refuse before any process starts
    this.refuseProfileOnAppServer(run);
    if (this.appServer) return this.appServer.start(run);
    const thread = this.codexFor(run).startThread(this.threadOptions(run));
    return this.launch(thread, run);
  }

  async resume(ref: ProviderSessionRef, run: RunSpec): Promise<RunHandle> {
    codexPermissions(run.permissionPolicy);
    this.refuseProfileOnAppServer(run);
    if (this.appServer) return this.appServer.start(run, ref);
    const thread = this.codexFor(run).resumeThread(ref, this.threadOptions(run));
    return this.launch(thread, run, ref);
  }

  async prepare(input: ProvisioningInput): Promise<ProvisioningPlan> {
    if (this.appServer) throw new ProvisioningError("unsupported_transport", "the Codex app-server transport does not take a provisioned profile yet");
    return codexProvisioningPlan(input);
  }

  async provision(plan: ProvisioningPlan): Promise<ProvisionedProfile> {
    return materializeProfile(plan, "codex");
  }

  async verify(profile: ProvisionedProfile): Promise<ProvisioningVerification> {
    if (!this.options.probePromptInput) return verifyProfileOnDisk(profile, "codex");
    let codexPath: string;
    try {
      codexPath = this.options.codex?.codexPathOverride ?? codexSdkBinary();
    } catch (err) {
      return verifyProfileOnDisk(profile, "codex", [{ name: "prompt_input_exit", ok: false, detail: `no Codex binary: ${err instanceof Error ? err.message : String(err)}` }]);
    }
    const evidence = await probeCodexProfile(profile, { codexPath, baseConfig: this.options.codex?.config, run: this.options.probeRun });
    return verifyProfileOnDisk(profile, "codex", evidence);
  }

  async dispose(profile: ProvisionedProfile): Promise<{ removed: boolean }> {
    return disposeProfileDir(profile);
  }

  private refuseProfileOnAppServer(run: RunSpec): void {
    requireProfileHarness(run.profile, "codex");
    if (run.profile && this.appServer) throw new NotSupportedError("a provisioned profile on the Codex app-server transport");
  }

  /**
   * A profile's `--config` overrides need their own Codex instance: the SDK takes config per
   * instance, not per thread. MCP servers name their secrets in `env_vars`; the values go only into
   * this instance's process environment, which Codex forwards to just those servers.
   */
  private codexFor(run: RunSpec): Codex {
    const launch = run.profile?.launch;
    if (!launch || launch.harness !== "codex") return this.codex;
    const secretEnv = mcpSecretEnv(run.profile, run.secretEnv);
    return new Codex({
      ...this.options.codex,
      config: codexProfileConfig(this.options.codex?.config, launch),
      ...(Object.keys(secretEnv).length > 0 ? { env: { ...(this.options.codex?.env ?? inheritedEnv()), ...secretEnv } } : {}),
    });
  }

  private threadOptions(run: RunSpec) {
    return {
      workingDirectory: run.workdir,
      model: run.model?.id === "default" ? undefined : run.model?.id,
      // Sandbox is the safety boundary; interactive approvals are not part of
      // this SDK's typed surface, so escalations are simply unavailable.
      ...codexPermissions(run.permissionPolicy),
    };
  }

  private async launch(thread: Thread, run: RunSpec, resumedThread?: string): Promise<RunHandle> {
    const runId = newRunId();
    const state: CodexRunState = { queue: new EventQueue<NormalizedEvent>(), abort: new AbortController(), ...(resumedThread ? { resumedThread } : {}) };
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
        ended = this.mapEvent(event, handle, emit, state) || ended;
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
    state: CodexRunState,
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
        emit({ type: "usage.updated", ...this.runUsage(event.usage, handle, state), raw: event });
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

  /**
   * The run's share of a thread total. The counted input is non-cached input (Codex's own
   * `non_cached_input`: `input_tokens` includes cached reads), and output includes reasoning;
   * cache reads are reported beside them, uncounted. A resumed thread with no baseline in this
   * process carries the thread total only, because counting it would count earlier runs again.
   */
  private runUsage(usage: Usage, handle: RunHandle, state: CodexRunState): Pick<NormalizedEvent, "summary" | "payload"> {
    const total: ThreadTotals = {
      input: usage.input_tokens, cached: usage.cached_input_tokens, cacheWrite: usage.cache_write_input_tokens ?? 0,
      output: usage.output_tokens, reasoning: usage.reasoning_output_tokens,
    };
    const thread = handle.providerSessionRef ?? state.resumedThread;
    const baseline = (thread ? this.threadTotals.get(thread) : undefined) ?? (state.resumedThread ? undefined : ZERO_TOTALS);
    if (thread) this.threadTotals.set(thread, total);
    const threadTotal = { inputTokens: total.input, cachedInputTokens: total.cached, outputTokens: total.output };
    if (!baseline) {
      return {
        summary: `Thread total in/out: ${total.input}/${total.output} (resumed thread, no baseline: not counted)`,
        payload: { scope: "thread", threadTotal },
      };
    }
    const run = (key: keyof ThreadTotals) => Math.max(0, total[key] - baseline[key]);
    const cachedInputTokens = run("cached");
    const inputTokens = Math.max(0, run("input") - cachedInputTokens);
    return {
      summary: `Tokens in/out: ${inputTokens}/${run("output")} (cache reads ${cachedInputTokens})`,
      payload: {
        scope: "run",
        inputTokens,
        outputTokens: run("output"),
        cachedInputTokens,
        cacheWriteInputTokens: run("cacheWrite"),
        reasoningOutputTokens: run("reasoning"),
        threadTotal,
      },
    };
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
    if (this.appServer) return this.appServer.events(handle);
    const state = this.runs.get(handle.runId);
    if (!state) throw new NotSupportedError(`events for unknown run ${handle.runId}`);
    return state.queue;
  }

  async cancel(handle: RunHandle): Promise<void> {
    if (this.appServer) return this.appServer.cancel(handle);
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

/** `process.env` without unset entries: the SDK's `env` replaces the inherited environment. */
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
}
