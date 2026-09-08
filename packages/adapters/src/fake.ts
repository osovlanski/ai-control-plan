import type {
  AdapterContextSample,
  AgentAdapter,
  AssistantId,
  CapabilityManifest,
  NormalizedEvent,
  ProviderSessionRef,
  RunHandle,
  RunId,
  RunInput,
  RunSpec,
} from "@agent-plane/core";
import { newRunId, NotSupportedError } from "@agent-plane/core";
import { EventQueue } from "./event-queue.js";

type EmittedEvent = Omit<NormalizedEvent, "runId" | "ts">;

export interface FakeScript {
  /** Events emitted before the terminal run.ended (which the adapter appends). */
  events: EmittedEvent[];
  /** Insert an approval.requested after this many events and wait for the answer. */
  approvalAfter?: number;
  ok?: boolean;
  delayMs?: number;
}

const DEFAULT_SCRIPT: FakeScript = {
  ok: true,
  events: [
    { type: "message", summary: "Planning the change", phase: "planning", payload: { text: "Planning the change" } },
    { type: "tool.started", summary: "$ ls src", payload: { toolUseId: "t1", tool: "shell", command: "ls src" } },
    { type: "tool.completed", summary: "$ ls src → exit 0", payload: { toolUseId: "t1", exitCode: 0 } },
    { type: "file.changed", summary: "update src/example.ts", phase: "editing", payload: { path: "src/example.ts", kind: "update" } },
    { type: "test.result", summary: "3 passed / 0 failed", phase: "testing", payload: { passed: 3, failed: 0 } },
    { type: "usage.updated", summary: "Tokens in/out: 1200/450", payload: { inputTokens: 1200, outputTokens: 450 } },
    { type: "message", summary: "Done — change applied and tests pass", payload: { text: "Done — change applied and tests pass" } },
  ],
};

interface FakeRunState {
  queue: EventQueue<NormalizedEvent>;
  cancelled: boolean;
  pendingApproval?: { requestId: string; resolve: (approved: boolean) => void };
  /** K9 scripted context observation (from `[FAKE:CONTEXT:…]` prompt markers). */
  context?: { unavailable: boolean; tokens?: number; window?: number };
  /** Set once a scripted `[FAKE:COMPACT]` boundary has fired — later samples show relief. */
  compacted?: boolean;
}

const FAKE_CONTEXT_WINDOW = 200_000;

/** Parse `[FAKE:CONTEXT:0.46]`, `[FAKE:CONTEXT:unavailable]`, `[FAKE:CONTEXT:nowindow]`. */
function parseContextMarker(prompt: string): FakeRunState["context"] | undefined {
  const m = prompt.match(/\[FAKE:CONTEXT:([^\]]+)\]/);
  if (!m) return undefined;
  const arg = m[1]!.trim().toLowerCase();
  if (arg === "unavailable") return { unavailable: true };
  if (arg === "nowindow") return { unavailable: false, tokens: 72_000 };
  const pressure = Number(arg);
  if (!Number.isFinite(pressure) || pressure < 0) return { unavailable: true };
  return { unavailable: false, tokens: Math.round(pressure * FAKE_CONTEXT_WINDOW), window: FAKE_CONTEXT_WINDOW };
}

/**
 * Deterministic in-process adapter for tests and local development
 * (provider "fake" in workspace config). Runs no real assistant.
 */
export class FakeAdapter implements AgentAdapter {
  private runs = new Map<string, FakeRunState>();

  constructor(
    readonly id: AssistantId,
    private script: FakeScript = DEFAULT_SCRIPT,
  ) {}

  async describe(): Promise<CapabilityManifest> {
    return {
      assistantId: this.id,
      provider: "fake",
      core: {
        models: [{ id: "fake-1", displayName: "Fake model" }],
        canResume: true,
        canMcp: false,
        supportsMidRunInput: true,
        reportsUsage: true,
        reportsLimits: true,
        execution: { shell: true, filesystem: true, web: "no" },
        auth: { state: "ok", account: "fake" },
      },
      // Honest for a synthetic double: `pump()` deterministically emits one
      // final-total `usage.updated` event, relays approvals via `send()`, and
      // gates nothing else — declaring it lets the Execution Harness's
      // token-usage telemetry (deferral-#5-adjacent, increment 3) see the same
      // numbers the legacy path reads straight off the raw event payload.
      harness: { usageAccounting: "cumulative", toolGating: "none", approvalRelay: true, processIsolation: "none" },
      // K9: `observeContext` returns whatever `[FAKE:CONTEXT:…]` scripted. No
      // compaction control is exposed (that is K10) — `compact: "none"`.
      context: {
        occupancy: "provider-reported",
        effectiveWindow: "provider-reported",
        compact: "none",
        autoManagement: "none",
        observesAutoCompaction: true,
      },
      providerDetail: { runtime: "fake" },
      evidence: { source: "runtime-probe", observedAt: new Date().toISOString() },
    };
  }

  async start(run: RunSpec): Promise<RunHandle> {
    const runId = newRunId();
    const state: FakeRunState = {
      queue: new EventQueue<NormalizedEvent>(),
      cancelled: false,
      context: parseContextMarker(run.prompt),
    };
    this.runs.set(runId, state);
    const handle: RunHandle = {
      runId,
      assistantId: this.id,
      providerSessionRef: `fake-session-${runId}` as ProviderSessionRef,
    };
    void this.pump(runId, handle, run, state);
    return handle;
  }

  async resume(ref: ProviderSessionRef, run: RunSpec): Promise<RunHandle> {
    const handle = await this.start(run);
    handle.providerSessionRef = ref;
    return handle;
  }

  private async pump(runId: RunId | string, handle: RunHandle, run: RunSpec, state: FakeRunState): Promise<void> {
    const emit = (e: EmittedEvent) =>
      state.queue.push({ runId: runId as RunId, ts: new Date().toISOString(), ...e });

    emit({
      type: "run.started",
      summary: "Fake run started",
      payload: { providerSessionRef: handle.providerSessionRef, model: run.model?.id ?? "fake-1" },
    });

    // Prompt-driven scenario switches (used by dev UI walkthroughs).
    const wantsApproval = this.script.approvalAfter !== undefined || run.prompt.includes("[FAKE:APPROVAL]");
    const approvalAfter = this.script.approvalAfter ?? 2;

    let i = 0;
    for (const event of this.script.events) {
      if (state.cancelled) return this.finish(state, emit, false, "cancelled");
      if (wantsApproval && i === approvalAfter) {
        const approved = await this.requestApproval(runId as string, state, emit);
        if (!approved) return this.finish(state, emit, false, "denied");
      }
      if (this.script.delayMs) await sleep(this.script.delayMs);
      emit(event);
      i += 1;
    }
    // Scripted provider auto-compaction (K9). Emitted AFTER the script events so
    // the Harness's next observation samples the post-compaction relief below.
    if (run.prompt.includes("[FAKE:COMPACT]") && !state.cancelled) {
      const pre = state.context?.tokens ?? 0;
      state.compacted = true;
      emit({
        type: "context.compaction.observed",
        summary: `Provider auto-compaction (${pre}→${Math.round(pre / 2)} tokens)`,
        payload: { trigger: "auto", preTokens: pre, postTokens: Math.round(pre / 2), requestedByPlane: false },
      });
    }
    // The limit fires only on a fresh start: a run that picked the task up via
    // handoff must be able to finish it, or a failover test never terminates.
    if (run.prompt.includes("[FAKE:LIMIT]") && !isHandoff(run.prompt)) {
      emit({
        type: "limit.hit",
        summary: "Fake quota exhausted",
        payload: { quota: [{ window: "5h", usedPercent: 100, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] },
      });
      return this.finish(state, emit, false, "limit");
    }
    if (run.prompt.includes("[FAKE:FAIL]") && !isHandoff(run.prompt)) {
      emit({ type: "error", summary: "Fake provider crashed" });
      return this.finish(state, emit, false, "error");
    }
    this.finish(state, emit, this.script.ok !== false);
  }

  private requestApproval(
    runId: string,
    state: FakeRunState,
    emit: (e: EmittedEvent) => void,
  ): Promise<boolean> {
    const requestId = `apr_fake_${Math.random().toString(36).slice(2, 8)}`;
    emit({
      type: "approval.requested",
      summary: "Fake tool wants to run `rm -rf ./dist`",
      payload: { requestId, tool: "shell", input: { command: "rm -rf ./dist" } },
    });
    return new Promise((resolve) => {
      state.pendingApproval = { requestId, resolve };
    });
  }

  private finish(state: FakeRunState, emit: (e: EmittedEvent) => void, ok: boolean, reason?: string): void {
    emit({ type: "run.ended", summary: ok ? "Run completed" : `Run ended (${reason})`, payload: { ok, reason } });
    state.queue.end();
  }

  events(handle: RunHandle): AsyncIterable<NormalizedEvent> {
    const state = this.runs.get(handle.runId);
    if (!state) throw new NotSupportedError(`events for unknown run ${handle.runId}`);
    return state.queue;
  }

  async send(handle: RunHandle, input: RunInput): Promise<void> {
    const state = this.runs.get(handle.runId);
    if (!state) throw new NotSupportedError(`send for inactive run ${handle.runId}`);
    if (input.kind === "approval" && state.pendingApproval?.requestId === input.requestId) {
      const pending = state.pendingApproval;
      state.pendingApproval = undefined;
      pending.resolve(input.approved);
      return;
    }
    throw new NotSupportedError(`no pending approval ${input.kind === "approval" ? input.requestId : ""}`);
  }

  async observeContext(handle: RunHandle): Promise<AdapterContextSample | null> {
    const state = this.runs.get(handle.runId);
    const cfg = state?.context;
    if (!state || !cfg || cfg.unavailable) return null;
    const tokens = cfg.tokens === undefined ? undefined : state.compacted ? Math.round(cfg.tokens / 2) : cfg.tokens;
    return {
      occupancyTokens: tokens,
      occupancySource: "provider-reported",
      effectiveWindowTokens: cfg.window,
      effectiveWindowSource: cfg.window === undefined ? "unavailable" : "provider-reported",
      advertisedMaxTokens: cfg.window,
    };
  }

  async cancel(handle: RunHandle): Promise<void> {
    const state = this.runs.get(handle.runId);
    if (state) {
      state.cancelled = true;
      if (state.pendingApproval) {
        const pending = state.pendingApproval;
        state.pendingApproval = undefined;
        pending.resolve(false);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mirrors HANDOFF_MARKER from the control plane's handoff renderer. */
function isHandoff(prompt: string): boolean {
  return prompt.includes("You are continuing work that another assistant started.");
}
