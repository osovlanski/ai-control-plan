import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantId, NormalizedEvent, RunSpec } from "@agent-plane/core";
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
import { CodexAdapter } from "../src/codex.js";

const run: RunSpec = { taskId: "AG-test" as never, prompt: "prompt", workdir: "/tmp", permissionPolicy: { mode: "read-only" }, env: { redactionRules: [], maxRuntimeMs: 2000 } };
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; exitCode: number | null; signalCode: string | null };
let requests: Array<{ id: number; method: string; params: Record<string, unknown> }>;
let turnResponse = true;
const notify = (method: string, params: Record<string, unknown>) => child.stdout.write(JSON.stringify({ method, params: { threadId: "thread", ...params } }) + "\n");
beforeEach(() => {
  requests = []; turnResponse = true;
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { child.signalCode = "SIGTERM"; return true; }), exitCode: null, signalCode: null });
  child.stdin.on("data", chunk => {
    const request = JSON.parse(String(chunk)); requests.push(request);
    if (!request.id || (request.method === "turn/start" && !turnResponse)) return;
    const result = request.method === "initialize" ? {} : request.method === "turn/start" ? { turn: { id: "turn" } } : request.method === "turn/steer" ? { turnId: "turn" } : { thread: { id: "thread", status: { type: "active", activeFlags: [] } } };
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
  });
  mock.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => { child.stdout.end(); });
const agent = () => new CodexAdapter("codex" as AssistantId, { appServerInput: true, codex: { codexPathOverride: "/pinned/codex" } });
async function started(owner: CodexAdapter) {
  const handle = await owner.start(run);
  const events: NormalizedEvent[] = [];
  const pump = (async () => { for await (const event of owner.events(handle)) events.push(event); })();
  await vi.waitFor(() => expect(requests.some(r => r.method === "turn/start")).toBe(true));
  return { handle, events, pump };
}

describe("opt-in Codex execution owner", () => {
  it("preserves default SDK behavior and does not launch a process merely to describe it", async () => {
    const defaults = new CodexAdapter("codex" as AssistantId);
    expect(defaults.sessionInput).toBeUndefined();
    expect((await defaults.describe()).providerDetail?.runtime).toBe("@openai/codex-sdk");
    expect((await agent().describe()).core.supportsMidRunInput).toBe(false);
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("refuses unsupported SDK credentials/config rather than silently changing accounts", () => {
    expect(() => new CodexAdapter("codex" as AssistantId, { appServerInput: true, codex: { env: { CODEX_HOME: "/custom/home" } } })).toThrow("custom SDK options");
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("owns the exact live thread and maps run, tool, output and usage events", async () => {
    const owner = agent(); const { handle, events, pump } = await started(owner);
    expect(mock.spawn).toHaveBeenCalledWith("/pinned/codex", ["app-server", "--listen", "stdio://"], expect.objectContaining({ cwd: "/tmp" }));
    expect(requests.find(r => r.method === "thread/start")?.params).toMatchObject({ cwd: "/tmp", sandbox: "read-only", approvalPolicy: "never" });
    const target = { sessionId: "kernel-session", assistantId: "codex", providerSessionRef: handle.providerSessionRef };
    expect(await owner.sessionInput!.enable(target)).toMatchObject({ available: true });
    await expect(owner.sessionInput!.deliver(target, { messageId: "m", kind: "text", text: "followup" })).rejects.toThrow("transport_ack_only");
    expect(requests.find(r => r.method === "turn/steer")?.params.clientUserMessageId).toBe("m");
    notify("item/started", { turnId: "turn", item: { id: "tool", type: "commandExecution", command: "sleep 1" } });
    notify("item/completed", { turnId: "turn", item: { id: "tool", type: "commandExecution", command: "sleep 1", status: "completed", exitCode: 0 } });
    notify("item/completed", { turnId: "turn", item: { type: "agentMessage", text: "done" } });
    notify("thread/tokenUsage/updated", { turnId: "turn", tokenUsage: { last: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1 } } });
    notify("turn/completed", { turn: { id: "turn", status: "completed" } });
    await pump;
    expect(events.map(e => e.type)).toEqual(["run.started", "tool.started", "tool.completed", "message", "usage.updated", "run.ended"]);
    expect(events.at(-1)?.payload).toEqual({ ok: true });
    expect(await owner.sessionInput!.probeTarget(target)).toMatchObject({ available: false });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("cancels the same turn and revokes reachability before completion", async () => {
    const owner = agent(); const { handle, events, pump } = await started(owner);
    const target = { sessionId: "kernel", assistantId: "codex", providerSessionRef: handle.providerSessionRef };
    await owner.sessionInput!.enable(target);
    await owner.cancel(handle); await pump;
    expect(requests.find(r => r.method === "turn/interrupt")?.params).toEqual({ threadId: "thread", turnId: "turn" });
    expect(await owner.sessionInput!.probeTarget(target)).toMatchObject({ available: false });
    expect(events.filter(e => e.type === "run.ended")).toHaveLength(1);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
  });

  it("reports disconnect as failure once and preserves unavailable capability", async () => {
    const owner = agent(); const { handle, events, pump } = await started(owner);
    child.emit("exit", 1); await pump;
    expect(events.filter(e => e.type === "run.ended")).toHaveLength(1);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
    expect(await owner.sessionInput!.enable({ sessionId: "kernel", assistantId: "codex", providerSessionRef: handle.providerSessionRef })).toMatchObject({ available: false });
  });

  it("keeps fast launch failures observable even if they happen before event subscription", async () => {
    mock.spawn.mockImplementation(() => { throw new Error("missing binary"); });
    const owner = agent(), handle = await owner.start(run);
    await new Promise(resolve => setImmediate(resolve));
    const events = []; for await (const event of owner.events(handle)) events.push(event);
    expect(events.map(e => e.type)).toEqual(["error", "run.ended"]);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
  });

  it("resumes only the requested thread and fences mismatched identities", async () => {
    const owner = agent(), handle = await owner.resume("other-thread" as never, run);
    const events = []; for await (const event of owner.events(handle)) events.push(event);
    expect(requests.find(r => r.method === "thread/resume")?.params.threadId).toBe("other-thread");
    expect(requests.some(r => r.method === "turn/start")).toBe(false);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
  });
});
