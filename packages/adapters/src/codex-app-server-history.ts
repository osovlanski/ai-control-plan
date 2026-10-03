import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SessionInputUnresolvedError } from "@agent-plane/core";
import { codexSdkBinary } from "./codex-sdk-binary.js";
import { CodexAppServerProtocol } from "./codex-app-server-protocol.js";

export type CodexHistoryReader = (threadId: string) => Promise<unknown>;

/** A fresh, read-only app-server process: no resume, new turn, steer, or replay. */
export async function readCodexThreadHistory(threadId: string, binary?: string): Promise<unknown> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(binary ?? codexSdkBinary(), ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new SessionInputUnresolvedError("codex_receipt_unresolved");
  }
  child.stderr.resume(); // Never expose provider diagnostics or transcript bodies.
  const rpc = new CodexAppServerProtocol(child.stdin, child.stdout, undefined, 10_000);
  child.on("error", () => rpc.disconnect());
  child.on("exit", () => rpc.disconnect());
  try {
    await rpc.initialize();
    const response = await rpc.request("thread/read", { threadId, includeTurns: true });
    if (response.error) throw new SessionInputUnresolvedError("codex_receipt_unresolved");
    return response.result?.thread;
  } catch {
    throw new SessionInputUnresolvedError("codex_receipt_unresolved");
  } finally {
    rpc.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    }
  }
}
