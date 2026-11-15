/**
 * P0-10 (docs/agentic-os-auto-copilot-plan.md §B, §D.3): the minimum morning report.
 *
 * One window, read from durable state only:
 *   - outcomes: every attempt the window touched (charged in it, ran a session in it, or was
 *     created while it was open), by state, with its reason and its publication;
 *   - runtime: the `autopilot_runtime` ms of the sessions admitted in this window, per attempt and
 *     in total, beside each attempt's whole-attempt use and budget;
 *   - tokens and overshoot: the attempt's task consumption (TaskAccounting, the same settlement the
 *     budget route reports) against the advisory `max_tokens` cap it was composed under (§D.3:
 *     advisory, so it is reported, never enforced);
 *   - charges: the window's charged count against its `max_items`;
 *   - stop reason: the autopilot's state now and why it is not running;
 *   - unresolved remote effects: publications waiting on itay, unsettled or unknown publication
 *     mutations nobody resolved, and acceptance runs that recorded effects the plane cannot know;
 *   - heartbeat gaps: from the D-14 ping ledger (P0-7a, `autopilot-heartbeat.ts`); with no
 *     `autopilot.heartbeat` configured the report says the figure is not tracked rather than
 *     reporting zero gaps;
 *   - attestation age: the newest billing attestation, its age and whether it is current.
 *
 * Nothing here writes. Token figures are provisional: usage records may still arrive.
 */
import type { BudgetCaps, TaskConsumption } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import { heartbeatSummary, type HeartbeatConfig, type HeartbeatSummary } from "./autopilot-heartbeat.js";

/** What the report needs from the composer's accounting; absent when the composer is off. */
export interface ReportAccounting {
  consumption(taskId: string): TaskConsumption;
  latestTaskCaps(taskId: string): BudgetCaps | undefined;
}

export interface MorningReportDeps {
  db: Db;
  now: () => Date;
  accounting?: ReportAccounting;
  /** `composer.policy.budget.maxTokens`: the cap when a task has no revision on record. */
  defaultMaxTokens?: number;
  /** `autopilot.heartbeat`: absent = the heartbeat is not tracked. */
  heartbeat?: HeartbeatConfig;
}

export interface MorningReportAttempt {
  attemptId: string;
  itemId: string;
  attemptNo: number;
  taskId: string | null;
  state: string;
  reason: string | null;
  finalAt: string | null;
  /** Runtime of this attempt's sessions admitted in this window. */
  windowRuntimeMs: number;
  /** Runtime of every session of the attempt, in any window, against its budget. */
  attemptRuntimeMs: number;
  runtimeBudgetMs: number;
  sessions: number;
  tokens: { used: number; cap: number | null; overshoot: number; sessions: number; provisional: true } | null;
  publication: { id: string; state: string; prNumber: number | null; prUrl: string | null } | null;
}

export interface UnresolvedEffect {
  kind: "publication_waiting" | "mutation_unsettled" | "mutation_unknown" | "acceptance_unknown_effects";
  attemptId: string;
  detail: string;
  publicationId?: string;
  mutationId?: number;
  acceptanceRunId?: string;
}

export interface MorningReport {
  asOf: string;
  window: { id: string; opensAt: string; closesAt: string; maxItems: number; charged: number; closed: boolean } | null;
  outcomes: Record<string, number>;
  attempts: MorningReportAttempt[];
  runtime: { windowMs: number };
  tokens: { used: number; overshoot: number; attemptsOverCap: number; available: boolean };
  autopilot: { status: string; stopReason: string | null; updatedAt: string };
  unresolvedEffects: UnresolvedEffect[];
  heartbeat: HeartbeatSummary;
  attestation: { attestedAt: string; expiresAt: string; ageHours: number; current: boolean; extraUsageOff: boolean; autoReloadOff: boolean } | null;
}

interface WindowRow { id: string; opens_at: string; closes_at: string; max_items: number }
interface AttemptRow {
  id: string; item_id: string; attempt_no: number; task_id: string | null; state: string; reason: string | null;
  final_at: string | null; runtime_budget_ms: number;
}

export class UnknownWindow extends Error {
  constructor(readonly windowId: string) { super(`no autopilot window ${windowId}`); }
}

/**
 * The window named, or else the most recent one that has opened by now. Null when no window has
 * ever opened: the report then still carries the stop reason, open effects and the attestation.
 */
function pickWindow(db: Db, at: string, windowId?: string): WindowRow | null {
  if (windowId !== undefined) {
    const row = db.prepare("SELECT id, opens_at, closes_at, max_items FROM autopilot_windows WHERE id = ?").get(windowId) as WindowRow | undefined;
    if (!row) throw new UnknownWindow(windowId);
    return row;
  }
  return (db.prepare("SELECT id, opens_at, closes_at, max_items FROM autopilot_windows WHERE opens_at <= ? ORDER BY opens_at DESC LIMIT 1").get(at) as WindowRow | undefined) ?? null;
}

export function morningReport(d: MorningReportDeps, opts: { windowId?: string } = {}): MorningReport {
  const { db } = d;
  const now = d.now();
  const asOf = now.toISOString();
  const w = pickWindow(db, asOf, opts.windowId);

  const rows: AttemptRow[] = w
    ? db.prepare(
      `SELECT id, item_id, attempt_no, task_id, state, reason, final_at, runtime_budget_ms FROM autopilot_attempts
        WHERE id IN (SELECT attempt_id FROM autopilot_window_charges WHERE window_id = @w)
           OR id IN (SELECT attempt_id FROM autopilot_sessions WHERE window_id = @w)
           OR (created_at >= @opens AND created_at < @closes)
        ORDER BY created_at, rowid`,
    ).all({ w: w.id, opens: w.opens_at, closes: w.closes_at }) as AttemptRow[]
    : [];

  const windowMs = db.prepare(
    `SELECT COALESCE(SUM(r.ms), 0) AS ms, COUNT(r.session_id) AS n FROM autopilot_sessions s
       JOIN autopilot_runtime r ON r.session_id = s.session_id WHERE s.window_id = ? AND s.attempt_id = ?`,
  );
  const attemptMs = db.prepare("SELECT COALESCE(SUM(ms), 0) AS ms FROM autopilot_runtime WHERE attempt_id = ?");
  const publicationOf = db.prepare("SELECT id, state, pr_number, pr_url FROM autopilot_publications WHERE attempt_id = ?");

  const attempts: MorningReportAttempt[] = rows.map((r) => {
    const inWindow = w ? (windowMs.get(w.id, r.id) as { ms: number; n: number }) : { ms: 0, n: 0 };
    const pub = publicationOf.get(r.id) as { id: string; state: string; pr_number: number | null; pr_url: string | null } | undefined;
    let tokens: MorningReportAttempt["tokens"] = null;
    if (d.accounting && r.task_id) {
      const used = d.accounting.consumption(r.task_id);
      const cap = d.accounting.latestTaskCaps(r.task_id)?.max_tokens ?? d.defaultMaxTokens ?? null;
      tokens = { used: used.tokens, cap, overshoot: cap === null ? 0 : Math.max(0, used.tokens - cap), sessions: used.sessions, provisional: true };
    }
    return {
      attemptId: r.id, itemId: r.item_id, attemptNo: r.attempt_no, taskId: r.task_id, state: r.state, reason: r.reason, finalAt: r.final_at,
      windowRuntimeMs: inWindow.ms, attemptRuntimeMs: (attemptMs.get(r.id) as { ms: number }).ms, runtimeBudgetMs: r.runtime_budget_ms,
      sessions: inWindow.n, tokens,
      publication: pub ? { id: pub.id, state: pub.state, prNumber: pub.pr_number, prUrl: pub.pr_url } : null,
    };
  });

  const outcomes: Record<string, number> = {};
  for (const a of attempts) outcomes[a.state] = (outcomes[a.state] ?? 0) + 1;

  const state = db.prepare("SELECT status, stop_reason, updated_at FROM autopilot_state WHERE id = 1").get() as { status: string; stop_reason: string | null; updated_at: string };

  // Open effects are reported whatever window they came from: a morning report that hid an older
  // unresolved create would let it be forgotten.
  const unresolvedEffects: UnresolvedEffect[] = [];
  for (const p of db.prepare("SELECT id, attempt_id, reason FROM autopilot_publications WHERE state IN ('publishing','publish_uncertain') ORDER BY created_at").all() as Array<{ id: string; attempt_id: string; reason: string | null }>) {
    unresolvedEffects.push({ kind: "publication_waiting", attemptId: p.attempt_id, publicationId: p.id, detail: p.reason ?? "publication not final" });
  }
  for (const m of db.prepare(
    `SELECT m.id, m.publication_id, m.kind, m.outcome, m.detail, p.attempt_id FROM autopilot_publication_mutations m
       JOIN autopilot_publications p ON p.id = m.publication_id
      WHERE m.resolved_at IS NULL AND (m.outcome IS NULL OR m.outcome = 'unknown') ORDER BY m.id`,
  ).all() as Array<{ id: number; publication_id: string; kind: string; outcome: string | null; detail: string | null; attempt_id: string }>) {
    unresolvedEffects.push({
      kind: m.outcome === null ? "mutation_unsettled" : "mutation_unknown", attemptId: m.attempt_id, publicationId: m.publication_id, mutationId: m.id,
      detail: `${m.kind}${m.detail ? `: ${m.detail}` : ""}`,
    });
  }
  for (const a of db.prepare("SELECT id, attempt_id, unknown_effects_json FROM acceptance_runs WHERE unknown_effects_json IS NOT NULL ORDER BY started_at").all() as Array<{ id: string; attempt_id: string; unknown_effects_json: string }>) {
    unresolvedEffects.push({ kind: "acceptance_unknown_effects", attemptId: a.attempt_id, acceptanceRunId: a.id, detail: a.unknown_effects_json });
  }

  const att = db.prepare("SELECT attested_at, expires_at, extra_usage_off, auto_reload_off FROM autopilot_billing_attestations ORDER BY id DESC LIMIT 1").get() as
    { attested_at: string; expires_at: string; extra_usage_off: number; auto_reload_off: number } | undefined;

  const withTokens = attempts.filter((a) => a.tokens);
  return {
    asOf,
    window: w ? {
      id: w.id, opensAt: w.opens_at, closesAt: w.closes_at, maxItems: w.max_items,
      charged: (db.prepare("SELECT COUNT(*) AS n FROM autopilot_window_charges WHERE window_id = ?").get(w.id) as { n: number }).n,
      closed: Date.parse(w.closes_at) <= now.getTime(),
    } : null,
    outcomes,
    attempts,
    runtime: { windowMs: attempts.reduce((n, a) => n + a.windowRuntimeMs, 0) },
    tokens: {
      used: withTokens.reduce((n, a) => n + a.tokens!.used, 0),
      overshoot: withTokens.reduce((n, a) => n + a.tokens!.overshoot, 0),
      attemptsOverCap: withTokens.filter((a) => a.tokens!.overshoot > 0).length,
      available: d.accounting !== undefined,
    },
    autopilot: { status: state.status, stopReason: state.stop_reason, updatedAt: state.updated_at },
    unresolvedEffects,
    heartbeat: heartbeatSummary(db, d.heartbeat, w ? { opensAt: w.opens_at, closesAt: w.closes_at } : null, now),
    attestation: att ? {
      attestedAt: att.attested_at, expiresAt: att.expires_at,
      ageHours: Math.round(((now.getTime() - Date.parse(att.attested_at)) / 3_600_000) * 10) / 10,
      current: att.extra_usage_off === 1 && att.auto_reload_off === 1 && Date.parse(att.expires_at) > now.getTime(),
      extraUsageOff: att.extra_usage_off === 1, autoReloadOff: att.auto_reload_off === 1,
    } : null,
  };
}

const mins = (ms: number) => (ms > 0 && ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);

/** The report as plain text for a terminal or an email body. */
export function renderMorningReport(r: MorningReport): string {
  const out: string[] = [`Autopilot morning report, ${r.asOf}`];
  if (!r.window) out.push("Window: none has opened yet");
  else out.push(`Window ${r.window.id}: ${r.window.opensAt} → ${r.window.closesAt}${r.window.closed ? "" : " (still open)"}; charged ${r.window.charged}/${r.window.maxItems}`);
  out.push(`Autopilot: ${r.autopilot.status}${r.autopilot.stopReason ? ` (stop reason: ${r.autopilot.stopReason})` : ""}`);
  const outcomes = Object.entries(r.outcomes).map(([s, n]) => `${s} ${n}`).join(", ");
  out.push(`Outcomes: ${outcomes || "no attempts"}`);
  for (const a of r.attempts) {
    const tokens = a.tokens ? ` · tokens ${a.tokens.used}${a.tokens.cap !== null ? `/${a.tokens.cap}${a.tokens.overshoot > 0 ? ` OVER by ${a.tokens.overshoot}` : ""}` : " (no cap)"}` : "";
    const pr = a.publication ? ` · ${a.publication.state}${a.publication.prUrl ? ` ${a.publication.prUrl}` : ""}` : "";
    out.push(`  ${a.itemId} #${a.attemptNo}: ${a.state}${a.reason ? ` (${a.reason})` : ""} · runtime ${mins(a.windowRuntimeMs)} this window, ${mins(a.attemptRuntimeMs)}/${mins(a.runtimeBudgetMs)} attempt${tokens}${pr}`);
  }
  out.push(`Runtime this window: ${mins(r.runtime.windowMs)}`);
  out.push(r.tokens.available
    ? `Tokens: ${r.tokens.used} (provisional); overshoot ${r.tokens.overshoot} across ${r.tokens.attemptsOverCap} attempt(s)`
    : "Tokens: not available (composer off)");
  out.push(r.unresolvedEffects.length ? `Unresolved remote effects: ${r.unresolvedEffects.length}` : "Unresolved remote effects: none");
  for (const e of r.unresolvedEffects) out.push(`  ${e.kind} · attempt ${e.attemptId}${e.publicationId ? ` · publication ${e.publicationId}` : ""} · ${e.detail}`);
  const hb = r.heartbeat;
  if (!hb.tracked || hb.gaps === null) out.push(`Heartbeat gaps: not tracked (${hb.detail})`);
  else {
    out.push(`Heartbeat: ${hb.pings} ping(s), ${hb.failed} failed; gaps ${hb.gaps.length ? hb.gaps.length : "none"} (${hb.detail})`);
    for (const g of hb.gaps) out.push(`  ${g.kind} ${g.from} → ${g.to} (${mins(g.ms)})`);
  }
  out.push(r.attestation
    ? `Billing attestation: ${r.attestation.ageHours}h old, expires ${r.attestation.expiresAt}, ${r.attestation.current ? "current" : "NOT current"}`
    : "Billing attestation: none on record");
  return out.join("\n");
}
