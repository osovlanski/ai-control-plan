import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
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

export interface CursorOptions {
  /** The CLI binary. Cursor renamed this once already, so it is configurable. */
  command?: string;
  model?: string;
}

interface CursorRunState {
  queue: EventQueue<NormalizedEvent>;
  child?: ChildProcessWithoutNullStreams;
  cancelled: boolean;
}

/**
 * Raised when the CLI emits a line this adapter does not recognise.
 *
 * Deliberately loud. A tier-2 CLI has no typed SDK to verify against, so the
 * failure mode to avoid is silently mis-mapping output into plausible-looking
 * events — a task would appear to run, produce nothing, and report success.
 */
export class CursorSchemaError extends Error {
  constructor(readonly line: string) {
    super(
      `Unrecognised Cursor CLI output. This adapter's mapping is UNVERIFIED — ` +
        `calibrate it against your installed CLI (see calibrateFromSamples) before relying on it. Line: ${line.slice(0, 200)}`,
    );
    this.name = "CursorSchemaError";
  }
}

/**
 * Cursor CLI adapter — SCAFFOLD, mapping unverified.
 *
 * Unlike the Claude and Codex adapters, this one could not be written against
 * installed type declarations: the Cursor CLI was not present and cursor.com
 * was unreachable from the build environment. Everything structural here
 * (process lifecycle, cancellation, manifest, registry wiring) is real and
 * tested; the single unverified piece is `mapCursorLine`, isolated below.
 *
 * To finish it on a machine that has the CLI:
 *   1. Run: agent -p --output-format json "say hello" > samples.jsonl
 *   2. Feed the lines to `calibrateFromSamples` to see what is unrecognised.
 *   3. Extend `mapCursorLine`; the rest of the adapter needs no changes.
 */
export class CursorAdapter implements AgentAdapter {
  private runs = new Map<string, CursorRunState>();

  constructor(
    readonly id: AssistantId,
    private options: CursorOptions = {},
  ) {}

  private get command(): string {
    return this.options.command ?? "agent";
  }

  async describe(): Promise<CapabilityManifest> {
    const version = await this.probeVersion();
    return {
      assistantId: this.id,
      provider: "cursor",
      core: {
        models: this.options.model ? [{ id: this.options.model }] : [{ id: "default", displayName: "Cursor default" }],
        // The CLI documents resume-by-chat-id, but this adapter could not
        // verify it. A wrong `true` breaks resume at runtime; a wrong `false`
        // only costs a fresh start. Asymmetric risk, so: false until verified.
        canResume: false,
        canMcp: true,
        supportsMidRunInput: false,
        reportsUsage: false,
        // No quota payload at this layer, same honest shape as Codex: limit
        // HITS are caught by error classification, with no early warning.
        reportsLimits: false,
        // Cursor Agent is a coding agent operating on a working tree; claiming
        // otherwise would make it unroutable for the only tasks it exists for.
        execution: { shell: true, filesystem: true, web: "unknown" },
        auth: version === "unavailable" ? { state: "missing", account: "cursor CLI not found" } : { state: "ok" },
      },
      providerDetail: {
        runtime: `${this.command} (CLI)`,
        version,
        /** Surfaced in the catalog so nobody trusts this mapping by accident. */
        mappingVerified: false,
      },
      evidence: { source: "runtime-probe", observedAt: new Date().toISOString() },
    };
  }

  private probeVersion(): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(this.command, ["--version"]);
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", () => resolve("unavailable"));
      child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : "unavailable"));
    });
  }

  async start(run: RunSpec): Promise<RunHandle> {
    const runId = newRunId();
    const state: CursorRunState = { queue: new EventQueue<NormalizedEvent>(), cancelled: false };
    this.runs.set(runId, state);
    const handle: RunHandle = { runId, assistantId: this.id };
    void this.pump(runId, handle, run, state);
    return handle;
  }

  async resume(_ref: ProviderSessionRef, _run: RunSpec): Promise<RunHandle> {
    throw new NotSupportedError(
      `${this.id}: resume is not verified for the Cursor CLI (manifest reports canResume: false)`,
    );
  }

  private async pump(runId: RunId, handle: RunHandle, run: RunSpec, state: CursorRunState): Promise<void> {
    const emit = (e: Omit<NormalizedEvent, "runId" | "ts">) =>
      state.queue.push({ runId, ts: new Date().toISOString(), ...e });

    const args = ["-p", "--output-format", "json"];
    if (this.options.model) args.push("--model", this.options.model);
    args.push(run.prompt);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, args, { cwd: run.workdir });
    } catch (err) {
      emit({ type: "error", summary: `Failed to start ${this.command}: ${String(err)}` });
      emit({ type: "run.ended", summary: "Run ended with error", payload: { ok: false } });
      state.queue.end();
      this.runs.delete(runId);
      return;
    }
    state.child = child;
    emit({ type: "run.started", summary: `Cursor CLI started (${this.command})`, payload: { pid: child.pid } });

    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        for (const event of mapCursorLine(line, handle)) emit(event);
      } catch (err) {
        // Loud, not silent: an unmapped line means this adapter is out of date
        // with the installed CLI, and pretending otherwise hides the problem.
        emit({ type: "error", summary: err instanceof Error ? err.message : String(err), raw: { line } });
      }
    }

    const code: number | null = await new Promise((resolve) => child.on("close", resolve));
    if (state.cancelled) {
      emit({ type: "run.ended", summary: "Run cancelled", payload: { ok: false, reason: "cancelled" } });
    } else if (code === 0) {
      emit({ type: "run.ended", summary: "Run completed", payload: { ok: true } });
    } else {
      if (stderr.trim()) emit({ type: "error", summary: truncate(stderr), raw: { stderr } });
      emit({ type: "run.ended", summary: `Run ended with exit ${code}`, payload: { ok: false, exitCode: code } });
    }
    state.queue.end();
    this.runs.delete(runId);
  }

  events(handle: RunHandle): AsyncIterable<NormalizedEvent> {
    const state = this.runs.get(handle.runId);
    if (!state) throw new NotSupportedError(`events for unknown run ${handle.runId}`);
    return state.queue;
  }

  async cancel(handle: RunHandle): Promise<void> {
    const state = this.runs.get(handle.runId);
    if (!state) return;
    state.cancelled = true;
    state.child?.kill("SIGTERM");
  }
}

/**
 * THE UNVERIFIED PIECE. Everything else in this file is structural and tested.
 *
 * Maps one line of `agent -p --output-format json` to normalized events.
 * Throws CursorSchemaError on anything unrecognised rather than guessing.
 */
export function mapCursorLine(line: string, handle?: RunHandle): Array<Omit<NormalizedEvent, "runId" | "ts">> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CursorSchemaError(line);
  }
  if (!parsed || typeof parsed !== "object") throw new CursorSchemaError(line);
  const record = parsed as Record<string, unknown>;
  const kind = typeof record.type === "string" ? record.type : undefined;

  switch (kind) {
    case "assistant":
    case "text":
    case "message": {
      const text = firstString(record, ["text", "message", "content"]);
      if (text === undefined) throw new CursorSchemaError(line);
      return [{ type: "message", summary: truncate(text), payload: { text }, raw: parsed }];
    }
    case "tool_call":
    case "tool_use": {
      const tool = firstString(record, ["name", "tool"]) ?? "tool";
      return [{ type: "tool.started", summary: tool, payload: { tool }, raw: parsed }];
    }
    case "tool_result": {
      const tool = firstString(record, ["name", "tool"]) ?? "tool";
      const failed = record.is_error === true || record.error !== undefined;
      return [{ type: failed ? "tool.failed" : "tool.completed", summary: tool, payload: { tool }, raw: parsed }];
    }
    case "result":
      // Terminal marker; the process close handler decides run.ended.
      return [];
    case "error": {
      const message = firstString(record, ["message", "error"]) ?? "Cursor reported an error";
      return [{ type: "error", summary: truncate(message), raw: parsed }];
    }
    default:
      if (handle) void handle; // keep the signature stable for future session capture
      throw new CursorSchemaError(line);
  }
}

/**
 * Calibration helper: feed captured CLI output and see exactly what the current
 * mapping does not understand, without running the control plane.
 */
export function calibrateFromSamples(lines: string[]): { mapped: number; unrecognised: string[] } {
  const unrecognised: string[] = [];
  let mapped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      mapCursorLine(line);
      mapped += 1;
    } catch {
      unrecognised.push(line);
    }
  }
  return { mapped, unrecognised };
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
