import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, type PermissionResult, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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

interface ClaudeRunState {
  queue: EventQueue<NormalizedEvent>;
  abort: AbortController;
  pendingApprovals: Map<string, (result: PermissionResult) => void>;
  pendingTools: Map<string, { tool: string; input: Record<string, unknown> }>;
  /** The live SDK query — kept so `observeContext` can issue `getContextUsage`. */
  stream?: Query;
  /** Advertised model maximum, lifted from `result.modelUsage[*].contextWindow`. */
  advertisedMaxTokens?: number;
}

/** Tools that mutate a file on disk, and where to find the path in their input. */
const FILE_MUTATING_TOOLS: Record<string, { pathKey: string; kind: string }> = {
  Write: { pathKey: "file_path", kind: "write" },
  Edit: { pathKey: "file_path", kind: "edit" },
  NotebookEdit: { pathKey: "notebook_path", kind: "edit" },
};

/**
 * Claude Code adapter over the Claude Agent SDK.
 *
 * Notable mappings:
 * - SDK `rate_limit_event` (subscription quota: utilization, resetsAt, window)
 *   → usage.updated / limit.approaching / limit.hit
 * - `canUseTool` permission callback → approval.requested event; the answer
 *   comes back through send({kind:"approval"}).
 * - `result` message → run.ended with modelUsage/total_cost_usd rollup.
 */
export class ClaudeAdapter implements AgentAdapter {
  private runs = new Map<string, ClaudeRunState>();

  /** `queryFn` is injectable for deterministic scripted-stream tests. */
  constructor(
    readonly id: AssistantId,
    private queryFn: typeof query = query,
  ) {}

  async describe(): Promise<CapabilityManifest> {
    const auth = detectAuth();
    return {
      assistantId: this.id,
      provider: "anthropic",
      core: {
        // Aliases the CLI resolves; enriched from supportedModels() after first live run.
        models: [
          { id: "opus", displayName: "Claude Opus (alias)" },
          { id: "sonnet", displayName: "Claude Sonnet (alias)" },
        ],
        canResume: true,
        canMcp: true,
        supportsMidRunInput: true,
        reportsUsage: true,
        reportsLimits: true, // SDKRateLimitEvent: utilization + resetsAt per window
        execution: { shell: true, filesystem: true, web: "yes" },
        auth,
      },
      // M14 K9 — the Agent SDK's `getContextUsage` control request reports live
      // occupancy (`totalTokens`) against the resolved autocompaction window
      // (`rawMaxTokens`), which is a DIFFERENT fact from the model's advertised
      // maximum (`ModelUsage.contextWindow`). `compact_boundary` system messages
      // are forwarded as `context.compaction.observed`. K9 exposes no compaction
      // control — that is K10, capability-gated.
      context: {
        occupancy: "provider-reported",
        effectiveWindow: "provider-reported",
        compact: "none",
        autoManagement: "provider",
        autoManagementDetail: "Claude Code auto-compaction (observed via compact_boundary)",
        observesAutoCompaction: true,
      },
      providerDetail: {
        runtime: "claude-agent-sdk",
        permissionModes: ["default", "acceptEdits", "bypassPermissions", "dontAsk", "auto"],
      },
      evidence: { source: "local-config", observedAt: new Date().toISOString() },
    };
  }

  async start(run: RunSpec): Promise<RunHandle> {
    return this.launch(run, undefined);
  }

  async resume(ref: ProviderSessionRef, run: RunSpec): Promise<RunHandle> {
    return this.launch(run, ref);
  }

  private async launch(run: RunSpec, resumeRef: ProviderSessionRef | undefined): Promise<RunHandle> {
    const runId = newRunId();
    const state: ClaudeRunState = {
      queue: new EventQueue<NormalizedEvent>(),
      abort: new AbortController(),
      pendingApprovals: new Map(),
      pendingTools: new Map(),
    };
    this.runs.set(runId, state);

    const handle: RunHandle = { runId, assistantId: this.id };

    const stream = this.queryFn({
      prompt: run.prompt,
      options: {
        cwd: run.workdir,
        model: run.model?.id,
        resume: resumeRef,
        abortController: state.abort,
        permissionMode: run.permissionPolicy.mode === "auto-approve" ? "bypassPermissions" : "default",
        allowDangerouslySkipPermissions: run.permissionPolicy.mode === "auto-approve" ? true : undefined,
        canUseTool:
          run.permissionPolicy.mode === "prompt-on-escalation"
            ? (toolName, input, opts) => this.onPermissionRequest(runId, toolName, input, opts)
            : undefined,
      },
    });

    state.stream = stream;
    void this.pump(runId, handle, stream, state);
    return handle;
  }

  private async pump(
    runId: RunId | string,
    handle: RunHandle,
    stream: AsyncIterable<SDKMessage>,
    state: ClaudeRunState,
  ): Promise<void> {
    const emit = (e: Omit<NormalizedEvent, "runId" | "ts"> & { ts?: string }) =>
      state.queue.push({ runId: runId as RunId, ts: e.ts ?? new Date().toISOString(), ...e });
    try {
      for await (const msg of stream) {
        this.mapMessage(msg, handle, state, emit);
      }
      state.queue.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (classifyLimit(message)) {
        emit({ type: "limit.hit", summary: `Provider limit: ${message}`, raw: { message } });
      }
      emit({ type: "error", summary: message, raw: { message } });
      emit({ type: "run.ended", summary: "Run ended with error", payload: { ok: false } });
      state.queue.end();
    } finally {
      this.runs.delete(String(runId));
    }
  }

  private mapMessage(
    msg: SDKMessage,
    handle: RunHandle,
    state: ClaudeRunState,
    emit: (e: Omit<NormalizedEvent, "runId" | "ts">) => void,
  ): void {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          handle.providerSessionRef = msg.session_id as ProviderSessionRef;
          emit({
            type: "run.started",
            summary: `Claude Code ${msg.claude_code_version} (${msg.model})`,
            payload: {
              providerSessionRef: msg.session_id,
              model: msg.model,
              tools: msg.tools,
              version: msg.claude_code_version,
            },
            raw: msg,
          });
        } else if (msg.subtype === "compact_boundary") {
          // The PROVIDER compacted its own transcript. This is not an Agentic OS
          // action (I-C1) — K9 issues no `/compact`. Forwarded instead of dropped.
          const meta = msg.compact_metadata;
          emit({
            type: "context.compaction.observed",
            summary: `Provider auto-compaction (${meta.trigger}, ${meta.pre_tokens}→${meta.post_tokens ?? "?"} tokens)`,
            payload: {
              trigger: meta.trigger === "auto" || meta.trigger === "manual" ? meta.trigger : "unknown",
              preTokens: meta.pre_tokens,
              postTokens: meta.post_tokens,
              requestedByPlane: false,
            },
            raw: msg,
          });
        }
        return;
      }
      case "assistant": {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            emit({ type: "message", summary: truncate(block.text), payload: { text: block.text }, raw: undefined });
          } else if (block.type === "tool_use") {
            if (block.name in FILE_MUTATING_TOOLS) {
              state.pendingTools.set(block.id, {
                tool: block.name,
                input: block.input as Record<string, unknown>,
              });
            }
            emit({
              type: "tool.started",
              summary: `${block.name}(${truncate(JSON.stringify(block.input), 120)})`,
              payload: { toolUseId: block.id, tool: block.name, input: block.input },
            });
          }
        }
        if (msg.error) {
          if (msg.error === "rate_limit") {
            emit({ type: "limit.hit", summary: "Claude API rate limit", raw: { error: msg.error } });
          }
        }
        return;
      }
      case "user": {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block.type === "tool_result") {
              emit({
                type: block.is_error ? "tool.failed" : "tool.completed",
                summary: block.is_error ? "Tool failed" : "Tool completed",
                payload: { toolUseId: block.tool_use_id },
              });
              const pending = state.pendingTools.get(block.tool_use_id);
              if (pending) {
                state.pendingTools.delete(block.tool_use_id);
                const spec = FILE_MUTATING_TOOLS[pending.tool];
                if (!block.is_error && spec) {
                  const path = pending.input[spec.pathKey];
                  if (typeof path === "string") {
                    emit({
                      type: "file.changed",
                      summary: `${spec.kind} ${path}`,
                      payload: { path, kind: spec.kind, tool: pending.tool },
                    });
                  }
                }
              }
            }
          }
        }
        return;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info;
        const usedPercent = info.utilization !== undefined ? Math.round(info.utilization * 100) : undefined;
        const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : undefined;
        const quota =
          usedPercent !== undefined
            ? [{ window: info.rateLimitType ?? "unknown", usedPercent, resetsAt }]
            : undefined;
        if (info.status === "rejected") {
          emit({ type: "limit.hit", summary: "Claude subscription limit reached", payload: { quota }, raw: msg });
        } else if (info.status === "allowed_warning") {
          emit({
            type: "limit.approaching",
            summary: `Claude quota warning (${usedPercent ?? "?"}% of ${info.rateLimitType ?? "window"})`,
            payload: { quota },
            raw: msg,
          });
        } else if (quota) {
          emit({ type: "usage.updated", summary: `Quota ${usedPercent}% of ${info.rateLimitType}`, payload: { quota }, raw: msg });
        }
        return;
      }
      case "result": {
        // Advertised model maximum (K9) — a different fact from the effective
        // autocompaction window `observeContext` reads. Keep the largest across
        // model-usage entries (subagents may run smaller-window models).
        const advertised = Math.max(
          0,
          ...Object.values(msg.modelUsage ?? {}).map((u) => (typeof u?.contextWindow === "number" ? u.contextWindow : 0)),
        );
        if (advertised > 0) state.advertisedMaxTokens = advertised;
        const usage = {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          costUsd: msg.total_cost_usd,
          modelUsage: msg.modelUsage,
        };
        emit({ type: "usage.updated", summary: `Tokens in/out: ${usage.inputTokens}/${usage.outputTokens}`, payload: usage });
        if (msg.subtype === "success" && !msg.is_error) {
          emit({
            type: "run.ended",
            summary: "Run completed",
            payload: { ok: true, finalText: msg.result, numTurns: msg.num_turns, durationMs: msg.duration_ms },
          });
        } else {
          const errors = msg.subtype === "success" ? [msg.result] : msg.errors;
          const text = errors.join("; ") || msg.subtype;
          if (classifyLimit(text)) {
            emit({ type: "limit.hit", summary: `Provider limit: ${truncate(text)}`, raw: { errors } });
          }
          emit({ type: "error", summary: truncate(text), raw: { subtype: msg.subtype, errors } });
          emit({ type: "run.ended", summary: "Run ended with error", payload: { ok: false, reason: msg.subtype } });
        }
        return;
      }
      default:
        return; // partial/status/hook messages: not part of the v1 normalized set
    }
  }

  private onPermissionRequest(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; title?: string },
  ): Promise<PermissionResult> {
    const state = this.runs.get(runId);
    if (!state) return Promise.resolve({ behavior: "deny", message: "Run no longer active" });
    const requestId = `apr_${Math.random().toString(36).slice(2, 10)}`;
    state.queue.push({
      runId: runId as RunId,
      ts: new Date().toISOString(),
      type: "approval.requested",
      summary: opts.title ?? `Allow ${toolName}?`,
      payload: { requestId, tool: toolName, input, title: opts.title },
    });
    return new Promise<PermissionResult>((resolve) => {
      state.pendingApprovals.set(requestId, resolve);
      opts.signal.addEventListener("abort", () => {
        state.pendingApprovals.delete(requestId);
        resolve({ behavior: "deny", message: "Aborted" });
      });
    });
  }

  events(handle: RunHandle): AsyncIterable<NormalizedEvent> {
    const state = this.runs.get(handle.runId);
    if (!state) throw new NotSupportedError(`events for unknown run ${handle.runId}`);
    return state.queue;
  }

  async send(handle: RunHandle, input: RunInput): Promise<void> {
    const state = this.runs.get(handle.runId);
    if (!state) throw new NotSupportedError(`send for inactive run ${handle.runId}`);
    if (input.kind === "approval") {
      const resolve = state.pendingApprovals.get(input.requestId);
      if (!resolve) throw new NotSupportedError(`approval ${input.requestId} not pending`);
      state.pendingApprovals.delete(input.requestId);
      resolve(
        input.approved
          ? { behavior: "allow" }
          : { behavior: "deny", message: "Denied by user via control plane" },
      );
      return;
    }
    throw new NotSupportedError("mid-run messages (Phase 1 supports approvals only)");
  }

  /**
   * M14 K9 — a live context sample from the Agent SDK's `getContextUsage`
   * control request. `totalTokens` is the provider's own occupancy figure;
   * `rawMaxTokens` is the resolved autocompaction window it is measured against.
   * Returns `null` when the query is gone or the control request fails, so the
   * Harness records no observation rather than a fabricated one.
   */
  async observeContext(handle: RunHandle): Promise<AdapterContextSample | null> {
    const state = this.runs.get(handle.runId);
    if (!state?.stream) return null;
    try {
      const u = await state.stream.getContextUsage();
      if (!u || typeof u.totalTokens !== "number") return null;
      const window = typeof u.rawMaxTokens === "number" && u.rawMaxTokens > 0 ? u.rawMaxTokens : undefined;
      return {
        occupancyTokens: u.totalTokens,
        occupancySource: "provider-reported",
        effectiveWindowTokens: window,
        effectiveWindowSource: window !== undefined ? "provider-reported" : "unavailable",
        advertisedMaxTokens: state.advertisedMaxTokens,
        // `getContextUsage`'s categories carry no used/free/buffer `kind`, so
        // exclude the non-content buckets by name — a breakdown that counts
        // "Free space" as occupancy would mislead.
        breakdown: Array.isArray(u.categories)
          ? u.categories
              .filter(
                (c) =>
                  !c.isDeferred &&
                  typeof c.tokens === "number" &&
                  c.tokens > 0 &&
                  !/^(free space|autocompact buffer)$/i.test(c.name),
              )
              .map((c) => ({ category: c.name, tokens: c.tokens }))
          : undefined,
      };
    } catch {
      return null;
    }
  }

  async cancel(handle: RunHandle): Promise<void> {
    this.runs.get(handle.runId)?.abort.abort();
  }
}

function detectAuth(): CapabilityManifest["core"]["auth"] {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { state: "ok", account: "env-credential" };
  }
  if (existsSync(join(homedir(), ".claude", ".credentials.json"))) {
    return { state: "ok", account: "claude-cli-login" };
  }
  return { state: "missing" };
}

function classifyLimit(text: string): boolean {
  return /rate.?limit|usage limit|quota|429|overloaded|credit/i.test(text);
}

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
