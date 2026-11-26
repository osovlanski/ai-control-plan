/**
 * Autopilot state v1 (docs/contracts/autopilot-state-v1.md): the read-only snapshot of the
 * autopilot that `GET /api/autopilot/state` serves and Cockpit vendors SHA-pinned. It is a
 * projection of the plane's own status readers, never a second derivation: every value here was
 * computed by the autopilot, the dispatcher or the restore service and is only copied, renamed to
 * the contract's field names, and redacted.
 *
 * Redaction: every free-text field (reasons, details, problems) passes `redactText` (secret
 * patterns) and then `redactAutopilotText`, which replaces absolute or home-relative filesystem
 * paths and URLs. Fields that would only ever carry a path or a reference the viewer cannot use
 * (worktree paths, reservation refs, backup names, SHAs) are not in the contract at all.
 */
import { REDACTED, redactText } from "./redaction.js";

export const AUTOPILOT_STATE_SCHEMA_VERSION = "1.0";
export const AUTOPILOT_STATE_RECENT_ATTEMPTS = 20;
export const AUTOPILOT_STATE_PATH = "[path]";
export const AUTOPILOT_STATE_URL = "[url]";

export const AUTOPILOT_STATUSES = ["stopped", "draining", "running"] as const;
export type AutopilotStatusValue = (typeof AUTOPILOT_STATUSES)[number];
export const AUTOPILOT_STATE_ATTEMPT_STATES = [
  "reserving", "admitted", "running", "suspended", "settled", "accepting", "accepted", "publishing", "publish_uncertain",
  "published", "closed", "failed", "blocked", "cancelled", "conflict", "external",
] as const;
export const AUTOPILOT_STATE_FINAL_ATTEMPT_STATES = ["published", "closed", "failed", "blocked", "cancelled", "conflict", "external"] as const;
export type AutopilotStateAttemptState = (typeof AUTOPILOT_STATE_ATTEMPT_STATES)[number];
export const AUTOPILOT_ITEM_STATUSES = ["queued", "retryable", "running", "in review", "done", "blocked", "skipped"] as const;
export const AUTOPILOT_TICK_ACTIONS = ["idle", "reserved", "drove"] as const;

export interface AutopilotStateWindow {
  id: string; opensAt: string; closesAt: string; maxItems: number; charged: number;
  /** True when a restore was detected inside the window: it admits no launch. */
  exhaustedByRestore: boolean;
}
export interface AutopilotStateAttempt {
  id: string; itemId: string; attemptNo: number; state: AutopilotStateAttemptState; final: boolean;
  reason: string | null; repo: string | null; taskId: string | null;
  runtimeBudgetMs: number; runtimeUsedMs: number; deadlineAt: string | null; deadlineBound: "budget" | "window" | null;
  createdAt: string; updatedAt: string; finalAt: string | null; requeuedAt: string | null;
}
export interface AutopilotStateProblem { setting: string; detail: string }
export interface AutopilotStateV1 {
  schemaVersion: typeof AUTOPILOT_STATE_SCHEMA_VERSION;
  observedAt: string;
  status: AutopilotStatusValue;
  stopReason: string | null;
  startedBy: string | null;
  updatedAt: string;
  window: AutopilotStateWindow | null;
  nextWindowOpensAt: string | null;
  windows: AutopilotStateWindow[];
  billingAttestation: { attestedAt: string; expiresAt: string; current: boolean } | null;
  settingProblems: AutopilotStateProblem[];
  currentAttempt: AutopilotStateAttempt | null;
  recentAttempts: AutopilotStateAttempt[];
  dispatcher: {
    problems: string[];
    inFlight: string[];
    selection: Array<{ itemId: string; status: (typeof AUTOPILOT_ITEM_STATUSES)[number]; reason: string }>;
    lastTick: { at: string; action: (typeof AUTOPILOT_TICK_ACTIONS)[number]; itemId: string | null; attemptId: string | null; detail: string | null } | null;
  };
  restore: {
    pending: boolean; reconciling: boolean; restoreId: string | null; detectedAt: string | null; reconciledAt: string | null;
    reconcileError: string | null; reportComplete: boolean | null; reportReadCurrent: boolean | null;
    startBlockedBy: AutopilotStateProblem | null;
  };
  openExternals: number;
}

/* ------------------------------------------------------------ sources -- */
// Structural shapes of the plane's readers (apps/api modules/autopilot*.ts), so core stays pure.

export interface AutopilotStateSourceWindow { id: string; opensAt: string; closesAt: string; maxItems: number; charged: number; exhaustedByRestore?: string }
export interface AutopilotStateSourceAttempt {
  id: string; itemId: string; attemptNo: number; state: string; reason?: string; repo?: string; taskId?: string;
  runtimeBudgetMs: number; runtimeUsedMs: number; deadlineAt?: string; deadlineBound?: "budget" | "window";
  createdAt: string; updatedAt: string; finalAt?: string; requeuedAt?: string;
}
export interface AutopilotStateSources {
  status: {
    status: AutopilotStatusValue; stopReason?: string; startedBy?: string; updatedAt: string;
    window: AutopilotStateSourceWindow | null; nextWindowOpensAt: string | null; attempt: AutopilotStateSourceAttempt | null;
    billingAttestation: { attestedAt: string; expiresAt: string; current: boolean } | null;
    settings: AutopilotStateProblem[];
  };
  windows: AutopilotStateSourceWindow[];
  attempts: AutopilotStateSourceAttempt[];
  dispatcher: {
    problems: string[]; inFlight: string[];
    selection: Array<{ itemId: string; status: string; reason: string }>;
    lastTick?: { at: string; result: { action: string; reason?: string; itemId?: string; attemptId?: string; outcome?: string; state?: string; detail?: string } };
  };
  restore: {
    pending: boolean; reconciling: boolean; restoreId?: string; detectedAt?: string; reconciledAt?: string; reconcileError?: string;
    reportComplete?: boolean; reportReadCurrent?: boolean; startBlockedBy?: AutopilotStateProblem;
  };
  openExternals: number;
}

/* ---------------------------------------------------------- redaction -- */

// A URL, then an absolute (`/a/b`) or home-relative (`~/a`) path. A path must start the text or
// follow whitespace, a quote, `(`, `=` or `,`, so `origin/main`, `a/b` config keys and the slashes
// inside a URL never match. The plane's own API routes (`/api/...`) are kept: details name them.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi;
// `token=…`, `credential: …`, `auth=…`: the shared rules only name `access_token`, `secret` and the like.
const ASSIGNED_RE = /\b(token|credential|auth|authorization)(\s*[:=]\s*)(?!\[REDACTED\])[^\s,;"']+/gi;
const PATH_RE = /(^|[\s"'(=,])(?!\/api\/)(~?\/[^\s"'<>),;]*)/g;

/** Replaces URLs and filesystem paths in free text. Applied after `redactText`. */
export function redactAutopilotText(text: string): string {
  return redactText(text)
    .replace(ASSIGNED_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(URL_RE, AUTOPILOT_STATE_URL)
    .replace(PATH_RE, (_m, lead: string, path: string) => `${lead}${path === "/" ? path : AUTOPILOT_STATE_PATH}`);
}
const text = (value: string | undefined | null): string | null => (value === undefined || value === null ? null : redactAutopilotText(value));
const problem = (p: AutopilotStateProblem): AutopilotStateProblem => ({ setting: p.setting, detail: redactAutopilotText(p.detail) });

/* --------------------------------------------------------- projection -- */

function window(w: AutopilotStateSourceWindow): AutopilotStateWindow {
  return { id: w.id, opensAt: w.opensAt, closesAt: w.closesAt, maxItems: w.maxItems, charged: w.charged, exhaustedByRestore: !!w.exhaustedByRestore };
}
function attempt(a: AutopilotStateSourceAttempt): AutopilotStateAttempt {
  return {
    id: a.id, itemId: a.itemId, attemptNo: a.attemptNo, state: a.state as AutopilotStateAttemptState,
    final: (AUTOPILOT_STATE_FINAL_ATTEMPT_STATES as readonly string[]).includes(a.state),
    reason: text(a.reason), repo: a.repo ?? null, taskId: a.taskId ?? null,
    runtimeBudgetMs: a.runtimeBudgetMs, runtimeUsedMs: a.runtimeUsedMs, deadlineAt: a.deadlineAt ?? null, deadlineBound: a.deadlineBound ?? null,
    createdAt: a.createdAt, updatedAt: a.updatedAt, finalAt: a.finalAt ?? null, requeuedAt: a.requeuedAt ?? null,
  };
}
function tickDetail(r: NonNullable<AutopilotStateSources["dispatcher"]["lastTick"]>["result"]): string | null {
  if (r.action === "idle") return text(r.reason);
  if (r.action === "reserved") return text(r.outcome);
  return text([r.state, r.detail].filter((x) => x !== undefined && x !== "").join(": ") || undefined);
}

/** The autopilot state v1 snapshot of the plane's readers at `observedAt`. Pure. */
export function projectAutopilotState(src: AutopilotStateSources, observedAt: string): AutopilotStateV1 {
  const s = src.status;
  const last = src.dispatcher.lastTick;
  const r = src.restore;
  return {
    schemaVersion: AUTOPILOT_STATE_SCHEMA_VERSION,
    observedAt,
    status: s.status,
    stopReason: text(s.stopReason),
    startedBy: s.startedBy ?? null,
    updatedAt: s.updatedAt,
    window: s.window ? window(s.window) : null,
    nextWindowOpensAt: s.nextWindowOpensAt,
    windows: src.windows.map(window),
    billingAttestation: s.billingAttestation ? { attestedAt: s.billingAttestation.attestedAt, expiresAt: s.billingAttestation.expiresAt, current: s.billingAttestation.current } : null,
    settingProblems: s.settings.map(problem),
    currentAttempt: s.attempt ? attempt(s.attempt) : null,
    recentAttempts: src.attempts.slice(0, AUTOPILOT_STATE_RECENT_ATTEMPTS).map(attempt),
    dispatcher: {
      problems: src.dispatcher.problems.map(redactAutopilotText),
      inFlight: [...src.dispatcher.inFlight],
      selection: src.dispatcher.selection.map((i) => ({ itemId: i.itemId, status: i.status as (typeof AUTOPILOT_ITEM_STATUSES)[number], reason: redactAutopilotText(i.reason) })),
      lastTick: last ? {
        at: last.at, action: last.result.action as (typeof AUTOPILOT_TICK_ACTIONS)[number],
        itemId: last.result.itemId ?? null, attemptId: last.result.attemptId ?? null, detail: tickDetail(last.result),
      } : null,
    },
    restore: {
      pending: r.pending, reconciling: r.reconciling, restoreId: r.restoreId ?? null, detectedAt: r.detectedAt ?? null,
      reconciledAt: r.reconciledAt ?? null, reconcileError: text(r.reconcileError),
      reportComplete: r.reportComplete ?? null, reportReadCurrent: r.reportReadCurrent ?? null,
      startBlockedBy: r.startBlockedBy ? problem(r.startBlockedBy) : null,
    },
    openExternals: src.openExternals,
  };
}
