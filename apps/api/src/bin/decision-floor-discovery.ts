/**
 * `pnpm --filter @agent-plane/api decision:floor-discovery [--db <path> | --actions <file.jsonl>] [--limit N] [--out <file.md>]`
 *
 * M16 K19i: the judge's only job. Reads recent tool calls — from a workspace
 * DB (default: this workspace's, read-only) or from a JSONL file of actions —
 * skips every call a floor already prompts on, asks the judge about the rest,
 * and writes floor CANDIDATES for a human to accept. It never gates anything.
 *
 * The judge is `decisions.discoveryProvider` of this workspace (K19l), read
 * by this job alone: `model` (default, Haiku on the workspace's own
 * `ANTHROPIC_API_KEY`) or `typesafe` (Jev, pinned by `decisions.typesafeModel`).
 * This is the process that sends, so it checks the workspace's I-D7 opt-in
 * itself and refuses (exit 1, nothing sent) without it. With no key every
 * call is counted as unjudged and the file says no judgement ran; the exit is
 * still 0, because a proposal job with nothing to propose has not failed. A
 * read or write error exits 1.
 *
 * A command reaches the judge only from a repo in this workspace's
 * `repoAllowlist` (§4.4), or, in an `--actions` file, the allowlist a row
 * carries. `--db` input is another workspace's, so it gets no allowlist, and
 * no command of it is sent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import type { McpToolPolicy } from "@agent-plane/core";
import { loadConfig, workspaceName } from "../config.js";
import { discoveryDecisionService } from "../modules/decision.js";
import { discoverFloorCandidates, readRecentToolActions, renderCandidates, type RecentToolAction } from "../modules/floor-discovery.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const limit = Number(arg("--limit") ?? 2_000);
// The workspace that SENDS: its judge, its opt-in. Checked before any input is read.
const workspace = loadConfig(process.env);
let service: ReturnType<typeof discoveryDecisionService>;
try {
  service = discoveryDecisionService(workspace.decisions, workspaceName(process.env));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
let actions: RecentToolAction[];
// `--db` is another workspace's record, so this workspace's allowlist does not vouch for its repos.
const repoAllowlist = arg("--db") ? undefined : workspace.repoAllowlist;
// The gate's own MCP policy (K19j), so a declared tool is judged here exactly
// when the gate would pass it. Only this workspace's config declares it;
// `--db` or `--actions` input gets none, and every MCP call stays floored.
let mcpTools: McpToolPolicy | undefined;
const actionsFile = arg("--actions");
if (actionsFile) {
  actions = readFileSync(actionsFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecentToolAction)
    .slice(0, limit);
} else {
  // Read-only and unmigrated: this job must never change a workspace's DB (openDb would migrate it).
  const own = !arg("--db");
  mcpTools = own ? workspace.decisions.mcpTools : undefined;
  const db = new Database(arg("--db") ?? workspace.dbPath, { readonly: true, fileMustExist: true });
  actions = readRecentToolActions(db, { limit });
  db.close();
}

const report = await discoverFloorCandidates(actions, (req) => service.decide(req), mcpTools, repoAllowlist);
const text = renderCandidates(report, new Date().toISOString());
const out = arg("--out");
if (out) writeFileSync(out, text);
else process.stdout.write(text);
console.error(
  `floor discovery: ${report.scanned} calls, ${report.distinct} distinct, ${report.floored} floored, ` +
    `${report.judged} judged, ${report.unjudged} unjudged, ${report.candidates.length} candidates` +
    (report.unjudgedReasons.length ? ` (unjudged: ${report.unjudgedReasons.join("; ")})` : "") +
    (out ? ` → ${out}` : ""),
);
