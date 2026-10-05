/**
 * `pnpm soak:check [--since <ISO>] [--now <ISO>] [--read-through <ISO>] [--db <path>] [--adapter <provider>] [--approval-mode <mode>]`
 *
 * The daily check for the tool gate's shadow soak: §7.1(1), (2) and (7), plus
 * the prompt rate grouped by floor reason. It opens the workspace DB read-only
 * and unmigrated (openDb would migrate it), so it changes nothing, and it
 * never records a reading: that is written by hand in `plans/progress.md`.
 *
 * `--since` defaults to the operator workspace's soak T0: the first boot with
 * `execution.harnessModes.single` on and a clean login environment. Earlier
 * rows came from parity runs with an env override, or from the flip's own
 * verification tasks, and are not the soak. `--read-through` is the time
 * through which the operator's reading is recorded.
 *
 * It judges one adapter/approval-mode pair (plan §7.4), by default Claude
 * (`anthropic`) under `prompt-on-escalation`, the one pair with a pre-exec
 * hook. Volume is distinct pre-exec calls of that pair against the owner's
 * `decisions.sites.tool-gate.soakMinPreExecCalls`, read from this workspace's
 * config; unset, the verdict is INSUFFICIENT.
 */
import { join } from "node:path";
import Database from "better-sqlite3";
import { configHome, loadConfig, workspaceName } from "../config.js";
import { toolGateSoakCheck } from "../modules/decision.js";

const SOAK_T0 = "2026-09-25T21:31:57.293Z";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const iso = (name: string, value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    console.error(`${name} must be an ISO 8601 time, got ${JSON.stringify(value)}`);
    process.exit(1);
  }
  return new Date(t).toISOString();
};

const dbPath = arg("--db") ?? join(configHome(), workspaceName(), "agent-plane.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const min = loadConfig(process.env).decisions.sites["tool-gate"].soakMinPreExecCalls;
const readThrough = iso("--read-through", arg("--read-through"));
const r = toolGateSoakCheck(db, {
  since: iso("--since", arg("--since")) ?? SOAK_T0,
  now: iso("--now", arg("--now")) ?? new Date().toISOString(),
  ...(readThrough ? { readThrough } : {}),
  adapter: arg("--adapter") ?? "anthropic",
  approvalMode: arg("--approval-mode") ?? "prompt-on-escalation",
  ...(min !== undefined ? { minPreExecCalls: min } : {}),
});
db.close();

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const out = [
  `tool-gate shadow soak — ${dbPath}`,
  `since ${r.since}  now ${r.now}  readings recorded through ${r.readThrough ?? "(none)"}`,
  `pair ${r.adapter} / ${r.approvalMode}`,
  "",
  `§7.1(1) volume        ${r.volume.verdict}  ${r.volume.preExecCalls} distinct pre-exec calls (${r.volume.calls} calls, ${r.volume.rows} rows) over ${r.volume.days.toFixed(2)} days; ` +
    `need ≥ 500, or ≥ 14 days and ≥ ${r.volume.minPreExecCalls ?? "(no minimum set: decisions.sites.tool-gate.soakMinPreExecCalls)"}; first ${r.volume.first ?? "-"}, last ${r.volume.last ?? "-"}`,
  `§7.1(2) disagreements ${r.disagreements.verdict}  ${r.disagreements.n} prompts where rules allowed, ${r.disagreements.unread} not yet read`,
  `§7.1(7) prompt rate   ${r.promptRate.verdict}  ${r.promptRate.byHook.map((h) => `${h.hook ?? "(no hook)"} ${h.prompts}/${h.calls} = ${pct(h.rate)}`).join("; ") || "no rules-allowed rows"}`,
  "",
  "prompts by floor reason:",
  ...(r.promptRate.byReason.length
    ? r.promptRate.byReason.map((b) => `  ${String(b.prompts).padStart(5)}  ${b.hook ?? "(no hook)"}  ${b.reason ?? "(no reason)"}`)
    : ["  (none)"]),
];
console.log(out.join("\n"));
