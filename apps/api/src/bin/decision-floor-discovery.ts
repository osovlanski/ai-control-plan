/**
 * `pnpm --filter @agent-plane/api decision:floor-discovery [--db <path> | --actions <file.jsonl>] [--input-workspace <name>] [--limit N] [--out <file.md>]`
 *
 * M16 K19i: the judge's only job. Reads recent tool calls — from a workspace
 * DB (default: this workspace's, read-only) or from a JSONL file of actions —
 * skips every call a floor already prompts on, asks the judge about the rest,
 * and writes floor CANDIDATES for a human to accept. It never gates anything.
 *
 * The judge is `decisions.discoveryProvider`: Jev (`typesafe`, pinned to
 * `jev-1.13`) by default once the workspace names `typesafeApiKeyRef`, with
 * `ModelDecisionProvider` on `ANTHROPIC_API_KEY` behind it; else `model` alone.
 * I-D7: Jev sees only the personal workspace's own calls. `--db` of another
 * workspace's DB, or `--actions`, is judged by `model` unless
 * `--input-workspace personal` says where the calls came from. With no
 * reachable judge every call is counted as unjudged and the file says so; the exit is still 0, because a proposal job
 * with nothing to propose has not failed. A read or write error exits 1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { McpToolPolicy } from "@agent-plane/core";
import { loadConfig, workspaceName } from "../config.js";
import { DecisionService, decisionProviders } from "../modules/decision.js";
import {
  discoverFloorCandidates,
  discoveryJudge,
  readRecentToolActions,
  renderCandidates,
  type RecentToolAction,
} from "../modules/floor-discovery.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const limit = Number(arg("--limit") ?? 2_000);
const workspace = loadConfig(process.env);
// I-D7 keys on the directory's name, never the file's own `workspace:` claim.
const workspaceDir = workspaceName(process.env);
const dbArg = arg("--db");
const ownDb = !dbArg || resolve(dbArg) === resolve(workspace.dbPath);
let actions: RecentToolAction[];
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
  mcpTools = dbArg ? undefined : workspace.decisions.mcpTools;
  const db = new Database(dbArg ?? workspace.dbPath, { readonly: true, fileMustExist: true });
  actions = readRecentToolActions(db, { limit });
  db.close();
}

// Where the calls came from: this workspace's own DB, else only what the operator declares.
const inputWorkspace = !actionsFile && ownDb ? workspaceDir : arg("--input-workspace");
const judge = discoveryJudge({ workspace: workspaceDir, decisions: workspace.decisions, inputWorkspace });
const service = new DecisionService(judge.config, decisionProviders(judge.config));
const report = await discoverFloorCandidates(actions, (req) => service.decide(req), mcpTools);
const text = renderCandidates(report, new Date().toISOString(), judge);
const out = arg("--out");
if (out) writeFileSync(out, text);
else process.stdout.write(text);
console.error(
  `floor discovery (judge ${judge.first}${judge.first === "typesafe" ? " → model" : ""}): ` +
    `${report.scanned} calls, ${report.distinct} distinct, ${report.floored} floored, ` +
    `${report.judged} judged (typesafe ${report.judgedBy.typesafe}, model ${report.judgedBy.model}, ${report.fallbacks} fallbacks), ` +
    `${report.unjudged} unjudged, ${report.candidates.length} candidates` +
    (judge.note ? ` [${judge.note}]` : "") +
    (report.fallbackReasons.length ? ` (fallback: ${report.fallbackReasons.join("; ")})` : "") +
    (report.unjudgedReasons.length ? ` (unjudged: ${report.unjudgedReasons.join("; ")})` : "") +
    (out ? ` → ${out}` : ""),
);
