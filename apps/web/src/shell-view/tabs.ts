import type { SessionDetail, SessionVerification, TaskContext, TaskDetail } from "../api.js";
import { verificationCheckView, verificationVerdict } from "../orbital.js";
import { contextPressure, kTok } from "./model.js";

/**
 * The shell's detail pane tabs, like `/proc/<pid>`. Each tab is a view over reads the plane already
 * serves; none writes, and none computes a value the plane owns (a stage, a verdict, a pressure).
 */
export const TABS = [
  { id: "log", key: "1", label: "log" },
  { id: "verify", key: "2", label: "verify" },
  { id: "files", key: "3", label: "files" },
  { id: "ctx", key: "4", label: "ctx" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

/** The run whose session the verify and files tabs read: the task's newest. */
export function lastRunId(detail: Pick<TaskDetail, "runs"> | undefined): string | null {
  return detail?.runs.at(-1)?.id ?? null;
}

export interface VerifyView {
  /** The plane's verdict (`passed` read with blocked and skipped counts); null while there is no result. */
  verdict: string | null;
  checks: Array<{ key: string; name: string; label: string; required: boolean; summary: string }>;
  /** The latest plan revision and why it exists (`initial`, `post_change`, `recovery`). */
  plan: string | null;
  /** Why there is nothing to list, when there is not. */
  note: string | null;
}

/** Each check as the plane reported it; a blocked check's install hint is its `summary`, shown verbatim. */
export function verifyView(session: SessionDetail | undefined, verification: SessionVerification | null | undefined): VerifyView {
  const revisions = verification?.revisions ?? [];
  const latest = revisions.reduce<SessionVerification["revisions"][number] | null>((best, r) => (!best || r.revision > best.revision ? r : best), null);
  const plan = latest ? `plan revision ${latest.revision} of ${revisions.length}: ${latest.reason}` : null;
  if (!session) return { verdict: null, checks: [], plan, note: "no execution session for this run (legacy path): no verification record" };
  const v = session.result?.verification;
  if (!v) {
    return { verdict: null, checks: [], plan, note: session.result ? "this run recorded no verification" : "no verification result yet: the run has not ended" };
  }
  const verdict = verificationVerdict(v);
  const extra = [verdict.blocked && verdict.label !== "blocked" ? `${verdict.blocked} blocked` : "", verdict.skipped ? `${verdict.skipped} skipped` : ""].filter(Boolean).join(", ");
  return {
    verdict: extra ? `${verdict.label} (${extra})` : verdict.label,
    checks: v.checks.map((c, i) => {
      const view = verificationCheckView(c);
      return { key: c.checkId ?? `${c.name}-${i}`, name: c.name, label: view.label, required: view.required, summary: view.detail };
    }),
    plan,
    note: v.checks.length ? null : "the verification plan had no checks",
  };
}

export interface FilesView {
  branch: string | null;
  files: string[];
  checkpoints: Array<{ id: string; reason: string; at: string; gitRef: string | null; diffStat: string | null }>;
}

/**
 * Branch and changed files from the task read, checkpoints from `/checkpoints`. The checkpoints route
 * carries `gitRef`; `diffStat` is on the session's own checkpoint record, joined by id and `null` where
 * there is no session (a legacy run).
 */
export function filesView(
  detail: Pick<TaskDetail, "branch" | "envelope"> | undefined,
  checkpoints: Array<{ id: string; reason: string; at: string; gitRef: string | null }>,
  session: SessionDetail | undefined,
): FilesView {
  const stats = new Map((session?.checkpoints ?? []).map(c => [c.id, c.diffStat]));
  return {
    branch: detail?.branch ?? null,
    files: detail?.envelope.artifacts.changedFiles ?? [],
    checkpoints: checkpoints.map(c => ({ ...c, diffStat: stats.get(c.id) ?? null })),
  };
}

export interface ContextView {
  /** Label/value pairs; `dim` values are unknown, absent or stale. */
  rows: Array<{ label: string; value: string; dim: boolean }>;
  breakdown: Array<{ category: string; tokens: string }>;
  note: string | null;
}

const row = (label: string, value: string, dim = false) => ({ label, value, dim });

/** K9's observation as sent. A percentage only where `contextPressure` allows one, dimmed when stale. */
export function contextView(ctx: TaskContext | null | undefined): ContextView {
  if (!ctx) return { rows: [], breakdown: [], note: "context read unavailable" };
  const rows: ContextView["rows"] = [];
  const o = ctx.status === "known" ? ctx.observation : undefined;
  if (!o) {
    return { rows, breakdown: [], note: ctx.reason ? `occupancy unavailable: ${ctx.reason}` : "occupancy unavailable: no context observation" };
  }
  const occupancy = o.occupancyTokens === undefined ? "unknown"
    : o.effectiveWindowTokens === undefined ? `${kTok(o.occupancyTokens)} tokens`
      : `${kTok(o.occupancyTokens)} / ${kTok(o.effectiveWindowTokens)} tokens`;
  const pressure = contextPressure(ctx);
  rows.push(row("occupancy", occupancy, o.occupancyTokens === undefined));
  rows.push(row("pressure", pressure.text, pressure.text === "—" || pressure.stale));
  rows.push(row("source", `${o.occupancySource}${o.estimator ? ` (${o.estimator.name} ${o.estimator.version})` : ""}`, o.occupancySource === "unavailable"));
  rows.push(row("window", `${o.effectiveWindowSource}`, o.effectiveWindowSource === "unavailable"));
  rows.push(row("freshness", o.freshness, o.freshness !== "live"));
  rows.push(row("auto-compaction", ctx.autoCompaction?.observed ? `observed ×${ctx.autoCompaction.count}` : "not observed", !ctx.autoCompaction?.observed));
  rows.push(ctx.continuation
    ? row("continuation", `${ctx.continuation.number} of ${ctx.continuation.limit}`)
    : row("continuation", "none", true));
  return {
    rows,
    breakdown: (o.breakdown ?? []).map(b => ({ category: b.category, tokens: kTok(b.tokens) })),
    note: null,
  };
}
