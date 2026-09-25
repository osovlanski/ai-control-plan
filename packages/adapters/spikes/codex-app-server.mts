/** Manual real-provider experiment. No transcript text, credentials or raw response bodies are saved. */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CodexAdapter } from "../src/codex.js";
import { SpikeProtocol, type RpcFrame } from "../test/support/codex-app-server-protocol.js";
import type { AssistantId, NormalizedEvent, RunHandle, RunSpec } from "@agent-plane/core";

if (process.env.LIVE_CODEX_APP_SERVER_SPIKE !== "1") throw new Error("Set LIVE_CODEX_APP_SERVER_SPIKE=1 for the bounded real-provider run");
const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
const cliRequire = createRequire(sdkRequire.resolve("@openai/codex/package.json"));
const platform = process.arch === "arm64" ? "arm64" : "x64";
const triple = platform === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
const cli = process.env.SPIKE_CODEX_BINARY ?? join(dirname(cliRequire.resolve(`@openai/codex-linux-${platform}/package.json`)), `vendor/${triple}/bin/codex`);
const workdir = mkdtempSync("/tmp/codex-same-session-");
execFileSync("git", ["init", "-q", workdir]);
const report: Record<string, unknown> = { cliVersion: execFileSync(cli, ["--version"], { encoding: "utf8" }).trim(), checks: [] };
const checks = report.checks as unknown[];
const marker = `SPIKE_FOLLOWUP_${Date.now()}`;
const events: NormalizedEvent[] = [];
const agent = new CodexAdapter("codex-spike" as AssistantId, { codex: process.env.SPIKE_CODEX_BINARY ? { codexPathOverride: cli } : undefined });
let handle: RunHandle | undefined;
let child: ReturnType<typeof spawn> | undefined;
let protocol: SpikeProtocol | undefined;
let pump: Promise<void> | undefined;
const deadline = setTimeout(() => { if (handle) void agent.cancel(handle); child?.kill(); }, 90_000);
function snapshot(frame: RpcFrame) {
  const thread = frame.result?.thread as { id: string; status?: unknown; path?: string; turns?: Array<{ id: string; status: string; items?: Array<{ type: string }> }> } | undefined;
  return {
    error: frame.error,
    resultKeys: Object.keys(frame.result ?? {}),
    turnId: frame.result?.turnId,
    thread: thread ? { id: thread.id, status: thread.status, turns: thread.turns?.map(t => ({ id: t.id, status: t.status, itemTypes: t.items?.map(i => i.type) })) } : undefined,
    sdkRunStillActive: !events.some(e => e.type === "run.ended"),
  };
}
async function connect() {
  const notifications: unknown[] = [];
  child = spawn(cli, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] });
  // Drain stderr but never persist provider diagnostics (may contain sensitive context).
  child.stderr!.resume();
  protocol = new SpikeProtocol(child.stdin!, child.stdout!, frame => {
    if (frame.method) notifications.push({ method: frame.method, paramKeys: Object.keys(frame.params ?? {}) });
  }, 10_000);
  child.on("error", () => protocol?.disconnect());
  const init = await protocol.initialize();
  checks.push({ operation: "initialize", response: { resultKeys: Object.keys(init.result ?? {}) }, notifications });
}
try {
  await connect();
  const spec: RunSpec = {
    taskId: "AG-CODEX-SPIKE" as never,
    prompt: "This is a bounded transport test. Run the shell command `sleep 40` exactly once, then reply exactly CODEX_SPIKE_DONE. Do not read or modify files, run other commands, use network tools, or delegate.",
    workdir,
    permissionPolicy: { mode: "auto-approve" },
    env: { redactionRules: [], maxRuntimeMs: 90_000 },
  };
  handle = await agent.start(spec);
  pump = (async () => { for await (const e of agent.events(handle!)) events.push(e); })();
  const until = Date.now() + 40_000;
  while (Date.now() < until && !events.some(e => e.type === "tool.started" || e.type === "run.ended")) await new Promise(r => setTimeout(r, 100));
  if (!events.some(e => e.type === "tool.started") || events.some(e => e.type === "run.ended") || !handle.providerSessionRef) throw new Error("No active AgentAdapter tool execution reached");
  const threadId = handle.providerSessionRef;
  report.sameThreadId = threadId;
  const read = await protocol!.request("thread/read", { threadId, includeTurns: true });
  checks.push({ operation: "thread/read-before-resume", ...snapshot(read) });
  const resumed = await protocol!.request("thread/resume", { threadId });
  checks.push({ operation: "thread/resume", ...snapshot(resumed) });
  const thread = (resumed.result?.thread ?? read.result?.thread) as { id?: string; path?: string; turns?: Array<{ id: string }> } | undefined;
  if (thread?.id !== threadId) throw new Error("app-server did not resolve the AgentAdapter thread identity");
  // Read only IDs and marker predicates from this experiment's own durable file.
  const records = thread.path ? readFileSync(thread.path, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const contexts = records.filter(r => r.type === "turn_context" && r.payload?.turn_id);
  const expectedTurnId = contexts.at(-1)?.payload.turn_id ?? thread.turns?.at(-1)?.id;
  report.expectedTurnId = expectedTurnId;
  if (!expectedTurnId) throw new Error("No provider-authored active turn identity available");
  const steer = await protocol!.request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text: marker }] });
  checks.push({ operation: "turn/steer", ...snapshot(steer) });
  // Restart only the experiment's app-server, never the SDK execution owner.
  protocol!.disconnect(); child!.kill();
  await connect();
  const after = await protocol!.request("thread/read", { threadId, includeTurns: true });
  checks.push({ operation: "thread/read-after-restart", ...snapshot(after) });
  // No replay of the non-idempotent steer, even if its response was lost.
  report.receipt = { exactMarkerInDurableFile: thread.path ? readFileSync(thread.path, "utf8").includes(marker) : null, messageIdentityReceiptProven: false };
  report.verdict = steer.error ? "BLOCKED" : "NEEDS_RECEIPT_ANALYSIS";
} catch (error) {
  report.verdict = "BLOCKED";
  report.failure = error instanceof Error ? error.message : "unknown";
} finally {
  clearTimeout(deadline);
  protocol?.disconnect(); child?.kill();
  if (handle) await agent.cancel(handle);
  await pump;
  report.agentEventTypes = events.map(e => e.type);
  const output = process.env.SPIKE_REPORT_PATH ?? join(workdir, "summary.json");
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
