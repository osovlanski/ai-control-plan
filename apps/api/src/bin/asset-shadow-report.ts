/**
 * `pnpm asset:shadow-report` — a read-only operator report over the M6 S4 asset shadow
 * (docs/agentic-os-m6-composition-telemetry.md §4.3).
 *
 * From durable state alone, over the 30-day window ending now:
 *   - the asset-shadow/v1 table per asset and cohort (task kind, harness): n, s, raw rate,
 *     baseline, w, lift, the idle-attachment control, and the method;
 *   - how many logged composition attempts the shadow would have changed, and the rate;
 *   - the most recent would-differ attempts, with both chosen sets and the deciding scores;
 *   - filter violations (a shadow choice a hard filter removed — must stay 0).
 *
 * It opens the database read-only and never migrates it (openDb would), so it is safe against a
 * live workspace DB. A database without the S1 ledger (037) or the S4 log (038) is refused with
 * the missing migration named. It never activates anything: M6 has no activation path (Q11).
 *
 *   pnpm asset:shadow-report [--db <path>] [--json] [--task-kind <kind>] [--harness <harness>]
 *
 * `--db` skips loading the workspace config. Through `pnpm --filter`, a relative path resolves
 * against apps/api.
 */
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { AssetCohortScore, AssetScores } from "@agent-plane/core";
import { loadConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { assetScores, parseScoresQuery, readShadowLog, shadowWindow, type ShadowLogSummary } from "../modules/asset-shadow.js";

/** What the report reads, by the migration that creates it. */
export const ASSET_SHADOW_REPORT_SCHEMA: ReadonlyArray<{ migration: string; table: string }> = [
  { migration: "037_asset_usage.sql", table: "asset_usage" },
  { migration: "038_asset_shadow_log.sql", table: "asset_shadow_log" },
];

export interface AssetShadowReport {
  asOf: string;
  filter: { taskKind?: string; harness?: string };
  scores: AssetScores;
  shadow: ShadowLogSummary;
}

/** The migrations this DB lacks, or [] when it can be read. Reads only. */
export function missingReportMigrations(db: Db): string[] {
  const hasTable = (name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  if (!hasTable("schema_migrations")) return ASSET_SHADOW_REPORT_SCHEMA.map((s) => s.migration);
  const applied = new Set((db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((r) => r.name));
  return ASSET_SHADOW_REPORT_SCHEMA.filter((s) => !applied.has(s.migration) || !hasTable(s.table)).map((s) => s.migration);
}

/** Opens a DB read-only and unmigrated; throws naming the missing migrations. */
export function openReportDb(path: string): Db {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const missing = missingReportMigrations(db);
  if (missing.length) {
    db.close();
    throw new Error(`asset shadow report: the database lacks ${missing.join(", ")}; run the plane once on this checkout to migrate it`);
  }
  return db;
}

export function buildAssetShadowReport(db: Db, now: Date, filter: { taskKind?: string; harness?: string } = {}): AssetShadowReport {
  const scores = assetScores(db, now, filter);
  return { asOf: now.toISOString(), filter, scores, shadow: readShadowLog(db, shadowWindow(now).start, 10) };
}

const num = (v: number | null) => (v === null ? "—" : v.toFixed(3));
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;

function scoreLine(c: AssetCohortScore): string {
  const o = c.outcome;
  const control = o.control ? ` idle n=${o.control.n} lift ${signed(o.control.lift)}` : "";
  const verified = c.verification.group.n > 0 || c.verification.baseline.n > 0
    ? `; verified: n=${c.verification.group.n} lift ${signed(c.verification.group.lift)}`
    : "";
  return `  ${c.assetKind} ${c.assetId} @${c.assetDigest.slice(0, 19)}  [${c.taskKind}/${c.harness}] ${c.method}\n` +
    `    ${c.method === "tool_event" ? "invoked" : "attached"} n=${o.group.n} s=${o.group.s} raw ${num(o.group.rate)} · baseline n=${o.baseline.n} p=${num(o.baseline.p)} · ` +
    `w=${o.group.w.toFixed(3)} · lift ${signed(o.group.lift)}${control}${o.noise ? " (noise: idle does as well)" : ""}${verified}` +
    `${c.method === "tool_event" ? "" : " · never ranks"}`;
}

export function renderAssetShadowReport(r: AssetShadowReport): string {
  const s = r.scores;
  const lines = [
    `Asset shadow report (${s.formula}, k=${s.k}) — SHADOW ONLY, no activation (M6 Q11)`,
    `window: ${s.window.start} → ${s.window.end}${r.filter.taskKind ? ` · taskKind ${r.filter.taskKind}` : ""}${r.filter.harness ? ` · harness ${r.filter.harness}` : ""}`,
    `sessions in window: ${s.sessions.inWindow} (sample ${s.sessions.sample}; excluded neutral ${s.sessions.neutral}, not_run ${s.sessions.notRun})`,
    "",
    `Scores per asset and cohort (${s.cohorts.length}):`,
    ...(s.cohorts.length ? s.cohorts.map(scoreLine) : ["  none: the ledger has no session in the window"]),
    "",
    "Pooled across cohorts, weighted by n (shown, never ranks):",
    ...(s.pooled.length ? s.pooled.map((p) => `  ${p.assetKind} ${p.assetId} @${(p.assetDigest ?? "").slice(0, 19)}  n=${p.n} lift ${signed(p.lift)} over ${p.cohorts} cohort(s)`) : ["  none"]),
    "",
    `Shadow log since ${r.shadow.since}:`,
    `  attempts logged ${r.shadow.logged} (scored ${r.shadow.scored}, errors ${r.shadow.errors})`,
    `  would differ ${r.shadow.wouldDiffer}${r.shadow.wouldDifferRate === null ? "" : ` (${(r.shadow.wouldDifferRate * 100).toFixed(1)}% of scored)`}`,
    `  filter violations ${r.shadow.filterViolations} (must be 0)`,
  ];
  if (r.shadow.attempts.length) {
    lines.push("", "Would-differ attempts (most recent first):");
    for (const a of r.shadow.attempts) {
      lines.push(`  ${a.attemptId} [${a.taskKind}/${a.harness}] at ${a.at}${a.overridden ? " (operator override applied after)" : ""}`);
      lines.push(`    stage 3: ${a.actual.join(", ") || "(none)"}`);
      lines.push(`    shadow:  ${(a.shadow ?? []).join(", ") || "(none)"}`);
      const deciding = (a.scores as Array<{ id: string; matched: number; lift: number; method: string; n: number }> | null) ?? [];
      for (const c of deciding) lines.push(`      ${c.id} matched ${c.matched} lift ${signed(c.lift)} (${c.method}, n=${c.n})`);
    }
  }
  return lines.join("\n");
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function main(): void {
  const filter = parseScoresQuery({ taskKind: arg("--task-kind"), harness: arg("--harness") });
  if (!filter.ok) throw new Error(filter.error);
  const dbArg = arg("--db");
  const db = openReportDb(dbArg ? resolve(dbArg) : loadConfig(process.env).dbPath);
  try {
    const report = buildAssetShadowReport(db, new Date(), {
      ...(filter.taskKind ? { taskKind: filter.taskKind } : {}), ...(filter.harness ? { harness: filter.harness } : {}),
    });
    process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${renderAssetShadowReport(report)}\n`);
  } finally {
    db.close();
  }
}

// Executed as a script, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}
