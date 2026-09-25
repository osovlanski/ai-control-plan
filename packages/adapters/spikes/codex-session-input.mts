/** Manual real-provider test. Save only metadata and boolean text predicates. */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { CodexAdapter } from "../src/codex.js";
import { codexSdkBinary } from "../src/codex-app-server-runtime.js";
import { CodexAppServerProtocol } from "../src/codex-app-server-protocol.js";
import type { AssistantId, NormalizedEvent, RunHandle } from "@agent-plane/core";
if (process.env.LIVE_CODEX_SESSION_INPUT !== "1") throw new Error("Set LIVE_CODEX_SESSION_INPUT=1");
const binary = codexSdkBinary();
const workdir = mkdtempSync("/tmp/codex-input-live-");
execFileSync("git", ["init", "-q", workdir]);
const agent = new CodexAdapter("codex-live" as AssistantId, { appServerInput: true });
const events: NormalizedEvent[] = [];
const marker = `CODEX_INPUT_${Date.now()}`;
const report: Record<string, unknown> = { cliVersion: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim() };
let handle: RunHandle | undefined;
let pump: Promise<void> | undefined;
const deadline = setTimeout(() => { if (handle) void agent.cancel(handle); }, 85_000);
try {
  handle = await agent.start({
    taskId: "AG-INPUT-LIVE" as never, workdir,
    prompt: "Bounded transport test: execute the shell command sleep 20 once. Then reply DONE. Do not read or modify files, use network tools, or delegate. If a follow-up arrives, include its marker in your final reply.",
    permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 80_000 },
  });
  pump = (async () => { for await (const event of agent.events(handle!)) events.push(event); })();
  const until = Date.now() + 45_000;
  while (Date.now() < until && !events.some(e => e.type === "tool.started" || e.type === "run.ended")) await new Promise(r => setTimeout(r, 100));
  if (!handle.providerSessionRef || !events.some(e => e.type === "tool.started") || events.some(e => e.type === "run.ended")) throw new Error("No live tool execution reached");
  const target = { sessionId: "manual-live-session", assistantId: agent.id, providerSessionRef: handle.providerSessionRef };
  report.beforeOptIn = await agent.sessionInput!.probeTarget(target);
  report.enable = await agent.sessionInput!.enable(target);
  report.capability = agent.sessionInput!.capabilities();
  const message = { messageId: "manual-message-1", kind: "text", text: `Include this follow-up marker in your final reply: ${marker}` };
  report.receipt = await agent.sessionInput!.deliver(target, message);
  try { await agent.sessionInput!.deliver(target, message); report.duplicateRefused = false; }
  catch { report.duplicateRefused = true; }
  await pump;
  report.afterExit = await agent.sessionInput!.probeTarget(target);
  report.outputContainsMarker = events.some(e => e.type === "message" && JSON.stringify(e.payload).includes(marker));
  // A fresh history reader after exit is observation only, never receipt lookup.
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const rpc = new CodexAppServerProtocol(child.stdin, child.stdout);
  child.on("error", () => rpc.disconnect());
  try {
    await rpc.initialize();
    const frame = await rpc.request("thread/read", { threadId: handle.providerSessionRef, includeTurns: true });
    const thread = frame.result?.thread as { turns?: Array<{ items?: Array<Record<string, unknown>> }> } | undefined;
    const items = thread?.turns?.flatMap(t => t.items ?? []) ?? [];
    report.history = { errorCode: frame.error?.code, userItems: items.filter(i => i.type === "userMessage").map(i => ({ keys: Object.keys(i), id: i.id, clientId: i.clientId, hasMarker: JSON.stringify(i.content).includes(marker), hasCallerMessageId: JSON.stringify(i).includes(message.messageId) })) };
  } finally { rpc.disconnect(); child.kill(); }
  report.verdict = "TRANSPORT_ONLY";
} catch (error) {
  report.verdict = "FAILED";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (handle) await agent.cancel(handle);
  await pump;
  report.eventTypes = events.map(e => e.type);
  writeFileSync(process.env.SPIKE_REPORT_PATH ?? "/tmp/codex-session-input-live.json", JSON.stringify(report, null, 2) + "\n");
  rmSync(workdir, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
