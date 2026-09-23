import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
import { readCodexThreadHistory } from "../src/codex-app-server-history.js";

function provider(error = false, exits = true) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn((signal: string) => {
      if (exits) queueMicrotask(() => { child.signalCode = signal; child.emit("exit"); });
      return true;
    }),
  });
  const requests: Array<{ id?: number; method: string; params: unknown }> = [];
  child.stdin.on("data", chunk => {
    const request = JSON.parse(String(chunk)); requests.push(request);
    if (request.id === undefined) return;
    const result = request.method === "initialize" ? {} : { thread: { id: "thread", turns: [] } };
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, ...(error && request.method === "thread/read" ? { error: { code: -32000, message: "private provider diagnostic" } } : { result }) }) + "\n"));
  });
  return { child, requests };
}
beforeEach(() => { mock.spawn.mockReset(); });

describe("fresh Codex history reader", () => {
  it("creates a new pinned process for each read, never loads a writer, and closes each process", async () => {
    const first = provider(), second = provider();
    mock.spawn.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
    await expect(readCodexThreadHistory("thread", "/pinned/codex")).resolves.toEqual({ id: "thread", turns: [] });
    await expect(readCodexThreadHistory("thread", "/pinned/codex")).resolves.toEqual({ id: "thread", turns: [] });
    expect(mock.spawn).toHaveBeenCalledTimes(2);
    expect(mock.spawn).toHaveBeenCalledWith("/pinned/codex", ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] });
    for (const p of [first, second]) {
      expect(p.requests.map(r => r.method)).toEqual(["initialize", "initialized", "thread/read"]);
      expect(p.requests.at(-1)?.params).toEqual({ threadId: "thread", includeTurns: true });
      expect(p.child.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });

  it("sanitizes read failures and still closes the process", async () => {
    const p = provider(true); mock.spawn.mockReturnValue(p.child);
    await expect(readCodexThreadHistory("thread", "/pinned/codex")).rejects.toThrow("codex_receipt_unresolved");
    expect(p.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps process launch failures unresolved without exposing diagnostics", async () => {
    mock.spawn.mockImplementation(() => { throw new Error("private launch diagnostic"); });
    const result = await readCodexThreadHistory("thread", "/pinned/codex").then(() => null, error => ({ name: error.name, message: error.message }));
    expect(result).toEqual({ name: "SessionInputUnresolvedError", message: "session input delivery unresolved: codex_receipt_unresolved" });
  });

  it("bounds cleanup when the history process ignores termination", async () => {
    vi.useFakeTimers();
    try {
      const p = provider(false, false); mock.spawn.mockReturnValue(p.child);
      const read = readCodexThreadHistory("thread", "/pinned/codex");
      await vi.advanceTimersByTimeAsync(1001);
      await expect(read).resolves.toEqual({ id: "thread", turns: [] });
      expect(p.child.kill.mock.calls.map(c => c[0])).toEqual(["SIGTERM", "SIGKILL"]);
    } finally { vi.useRealTimers(); }
  });
});
