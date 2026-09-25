import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { newRunId, NotSupportedError, type AssistantId, type NormalizedEvent, type ProviderSessionRef, type RunHandle, type RunSpec } from "@agent-plane/core";
import { CodexAppServerProtocol, type RpcFrame } from "./codex-app-server-protocol.js";
import { CodexSessionInputAdapter, type CodexInputConnection } from "./codex-session-input.js";
import { EventQueue } from "./event-queue.js";

interface State {
  handle: RunHandle;
  queue: EventQueue<NormalizedEvent>;
  child?: ChildProcessWithoutNullStreams;
  rpc?: CodexAppServerProtocol;
  input?: CodexInputConnection;
  ended: boolean;
  cancelling?: boolean;
  usage?: Record<string, unknown>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Use the SDK's pinned CLI, not an unrelated PATH installation. */
export function codexSdkBinary(): string {
  const sdk = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const cli = createRequire(sdk.resolve("@openai/codex/package.json"));
  const arch = process.arch;
  const os = process.platform;
  const triples: Record<string, string> = {
    "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl",
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "win32-arm64": "aarch64-pc-windows-msvc", "win32-x64": "x86_64-pc-windows-msvc",
  };
  const triple = triples[`${os}-${arch}`];
  if (!triple) throw new NotSupportedError("Codex app-server platform");
  return join(dirname(cli.resolve(`@openai/codex-${os}-${arch}/package.json`)), `vendor/${triple}/bin/codex${os === "win32" ? ".exe" : ""}`);
}

/** Explicitly opted-in execution owner. One app-server child per run. */
export class CodexAppServerRuntime {
  private readonly runs = new Map<string, State>();
  readonly sessionInput: CodexSessionInputAdapter;

  constructor(private readonly id: AssistantId, private readonly binary?: string) {
    this.sessionInput = new CodexSessionInputAdapter(id, (ref) => {
      for (const state of this.runs.values()) if (!state.ended && !state.cancelling && state.input?.threadId === ref) return state.input;
      return undefined;
    });
  }

  async start(run: RunSpec, ref?: ProviderSessionRef): Promise<RunHandle> {
    const state: State = { handle: { runId: newRunId(), assistantId: this.id }, queue: new EventQueue(), ended: false };
    this.runs.set(state.handle.runId, state);
    void this.launch(state, run, ref).catch(() => this.finish(state, false, "Codex app-server execution failed"));
    return state.handle;
  }

  private async launch(state: State, run: RunSpec, ref?: ProviderSessionRef): Promise<void> {
    const child = spawn(this.binary ?? codexSdkBinary(), ["app-server", "--listen", "stdio://"], {
      cwd: run.workdir, env: { ...process.env, ...run.secretEnv }, stdio: ["pipe", "pipe", "pipe"],
    });
    state.child = child;
    child.stderr.resume(); // Diagnostics can contain credentials or transcript text.
    const rpc = new CodexAppServerProtocol(child.stdin, child.stdout, (frame) => this.notification(state, frame), 10_000,
      () => this.finish(state, false, "Codex app-server disconnected"));
    state.rpc = rpc;
    child.on("error", () => rpc.disconnect());
    child.on("exit", () => rpc.disconnect());
    state.timer = setTimeout(() => { void this.cancel(state.handle); }, Math.max(1, run.env.maxRuntimeMs));
    await rpc.initialize();
    const response = await rpc.request(ref ? "thread/resume" : "thread/start", {
      ...(ref ? { threadId: ref } : {}), cwd: run.workdir,
      model: run.model?.id === "default" ? undefined : run.model?.id,
      sandbox: run.permissionPolicy.mode === "read-only" ? "read-only" : "workspace-write",
      approvalPolicy: "never",
    });
    const thread = object(response.result?.thread);
    if (response.error || typeof thread.id !== "string" || (ref && thread.id !== ref)) throw new Error("thread identity unavailable");
    if (state.ended) return;
    state.handle.providerSessionRef = thread.id as ProviderSessionRef;
    this.emit(state, { type: "run.started", summary: "Codex app-server thread started", payload: { providerSessionRef: thread.id } });
    const turnResponse = await rpc.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: run.prompt }] });
    const turn = object(turnResponse.result?.turn);
    if (turnResponse.error || typeof turn.id !== "string") throw new Error("turn identity unavailable");
    if (!state.ended && !state.cancelling) state.input = { threadId: thread.id, turnId: turn.id, rpc };
  }

  private notification(state: State, frame: RpcFrame): void {
    const p = frame.params;
    if (state.ended || !p || !state.handle.providerSessionRef || p.threadId !== state.handle.providerSessionRef) return;
    const item = object(p.item);
    const turn = object(p.turn);
    if (state.input && typeof p.turnId === "string" && p.turnId !== state.input.turnId) return;
    switch (frame.method) {
      case "turn/started":
        if (!state.cancelling && typeof turn.id === "string" && state.rpc) state.input = { threadId: p.threadId as string, turnId: turn.id, rpc: state.rpc };
        break;
      case "item/started":
        if (item.type === "commandExecution") this.emit(state, { type: "tool.started", summary: `$ ${short(item.command)}`, payload: { toolUseId: item.id, tool: "shell", command: item.command } });
        break;
      case "item/completed":
        this.item(state, item);
        break;
      case "thread/tokenUsage/updated": {
        const usage = object(object(p.tokenUsage).last);
        if (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") {
          state.usage = {
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens, reasoningOutputTokens: usage.reasoningOutputTokens,
          };
        }
        break;
      }
      case "turn/completed":
        if (state.input && turn.id !== state.input.turnId) return;
        if (/rate.?limit|usage limit|quota|429/i.test(String(object(turn.error).message ?? ""))) {
          this.emit(state, { type: "limit.hit", summary: "Codex provider limit" });
        }
        this.finish(state, turn.status === "completed", turn.status === "completed" ? "Run completed" : "Codex turn failed or interrupted");
        break;
      // User input items and model output NEVER produce session-input receipts.
    }
  }

  private item(state: State, item: Record<string, unknown>): void {
    switch (item.type) {
      case "agentMessage":
        if (typeof item.text === "string") this.emit(state, { type: "message", summary: short(item.text), payload: { text: item.text } });
        break;
      case "reasoning": {
        const text = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].filter(x => typeof x === "string").join("\n");
        if (text) this.emit(state, { type: "message", summary: short(text), payload: { text, kind: "reasoning" } });
        break;
      }
      case "commandExecution":
        this.emit(state, { type: item.status === "completed" ? "tool.completed" : "tool.failed", summary: `$ ${short(item.command, 100)} → exit ${item.exitCode ?? "?"}`, payload: {
          toolUseId: item.id, tool: "shell", command: item.command, exitCode: item.exitCode, output: short(item.aggregatedOutput, 2000),
        } });
        break;
      case "fileChange":
        for (const value of Array.isArray(item.changes) ? item.changes : []) {
          const change = object(value);
          this.emit(state, { type: "file.changed", summary: short(change.path), payload: { path: change.path, kind: object(change.kind).type, ok: item.status === "completed" } });
        }
        break;
      case "mcpToolCall":
        this.emit(state, { type: item.status === "completed" ? "tool.completed" : "tool.failed", summary: `MCP ${short(item.server)}.${short(item.tool)}`, payload: { toolUseId: item.id, tool: `mcp:${short(item.server)}.${short(item.tool)}` } });
        break;
    }
  }

  private emit(state: State, event: Omit<NormalizedEvent, "runId" | "ts">): void {
    state.queue.push({ runId: state.handle.runId as NormalizedEvent["runId"], ts: new Date().toISOString(), ...event });
  }

  private finish(state: State, ok: boolean, summary: string): void {
    if (state.ended) return;
    state.ended = true;
    state.input = undefined;
    clearTimeout(state.timer);
    // Like SDK turn.completed: publish the final provider usage snapshot once.
    if (state.usage) this.emit(state, { type: "usage.updated", summary: "Codex turn token usage", payload: state.usage });
    if (!ok) this.emit(state, { type: "error", summary });
    this.emit(state, { type: "run.ended", summary, payload: { ok } });
    state.queue.end();
    state.rpc?.disconnect();
    state.child?.kill();
    // Bound child cleanup even if a broken runtime ignores SIGTERM.
    const child = state.child;
    if (child) { const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2_000); timer.unref(); }
  }

  async *events(handle: RunHandle): AsyncIterable<NormalizedEvent> {
    const state = this.runs.get(handle.runId);
    if (!state) throw new NotSupportedError("events for unknown Codex app-server run");
    try { yield* state.queue; } finally { this.finish(state, false, "Event consumer closed"); this.runs.delete(handle.runId); }
  }

  async cancel(handle: RunHandle): Promise<void> {
    const state = this.runs.get(handle.runId);
    if (!state || state.ended) return;
    state.cancelling = true;
    const input = state.input;
    // Revoke send reachability before awaiting cancellation.
    state.input = undefined;
    try {
      if (input?.rpc.connected) await input.rpc.request("turn/interrupt", { threadId: input.threadId, turnId: input.turnId });
    } catch { /* Killing our execution owner is the bounded cancellation fallback. */ }
    finally { this.finish(state, false, "Run cancelled"); }
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function short(value: unknown, max = 200): string { return typeof value === "string" ? value.slice(0, max) : ""; }
