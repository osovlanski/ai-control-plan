import type { Assistant, CompositionBudget, SessionDetail, TaskContext, TaskDetail, TaskEvent } from "../api.js";
import { missionState, type Mission } from "../board/execution.js";
import { verificationCheckView } from "../orbital.js";

/** Presentation vocabulary for the process list. It maps the plane's state; it adds none. */
export type ProcessState = "NEEDS-YOU" | "RUNNING" | "WAITING" | "UNKNOWN" | (string & {});

const ATTENTION = new Set(["WAITING_INPUT", "AWAITING_APPROVAL", "LIMIT_PAUSED"]);
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export function processState(task: Mission): ProcessState {
  const state = missionState(task);
  if (ATTENTION.has(state)) return "NEEDS-YOU";
  if (state === "RUNTIME_UNKNOWN") return "UNKNOWN";
  if (state === "WAITING_RESOURCE" || (!TERMINAL.has(state) && task.wait?.state === "active")) return "WAITING";
  return state.replaceAll("_", "-");
}

/** Lower sorts first. NEEDS-YOU is always pinned above any column sort. */
export function stateRank(task: Mission): number {
  const s = processState(task);
  if (s === "NEEDS-YOU") return 0;
  if (s === "RUNNING" || s === "UNKNOWN") return 1;
  if (s === "WAITING") return 2;
  return TERMINAL.has(task.state) ? 4 : 3;
}

/** What a NEEDS-YOU row is waiting on, from its live sessions: pending approvals (with the tool, when the event names one) and a recovery offer. */
export interface Attention {
  approvals: Array<{ requestId: string; tool: string | null }>;
  restartOffered: boolean;
}

/**
 * The plane's per-task reads behind one row. `budget: "off"` = composer disabled, `"unavailable"` = read failed.
 * The optional reads are absent when the row does not need them: `context` for RUNNING rows only,
 * `session` (the last run's session) once that run has ended, `attention` for NEEDS-YOU rows only.
 */
export interface ProcessDetail {
  detail: TaskDetail;
  budget: CompositionBudget | "off" | "unavailable";
  context?: TaskContext | "unavailable";
  session?: SessionDetail | "unavailable";
  attention?: Attention | "unavailable";
}

export interface ProcessRow {
  pid: string;
  state: ProcessState;
  rawState: string;
  phase: string;
  assistant: string;
  model: string;
  tokens: string;
  cost: string;
  ctx: string;
  /** The context percent is from a stale observation, shown dimmed. */
  ctxStale: boolean;
  checks: string;
  /** Per-status counts behind CHECKS, skipped included, for the cell's title. */
  checksTitle: string;
  age: string;
  goal: string;
  /** A NEEDS-YOU row's known cause, shown in GOAL's place; null shows the goal. */
  cause: string | null;
  task: Mission;
}

export const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n));

export function formatAge(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Live runs if any, else the last run. Parallel runs show every live assistant. */
function currentRuns(detail: TaskDetail) {
  const live = detail.runs.filter(r => !r.ended_at);
  return live.length ? live : detail.runs.slice(-1);
}

export function assistantCell(p: ProcessDetail | undefined): string {
  if (!p) return "…";
  const runs = currentRuns(p.detail);
  return runs.length ? [...new Set(runs.map(r => r.assistant_id))].join("+") : "—";
}

/** The provider's resolved model for the run; `unknown` where it reported none. Never the requested selector. */
export function modelCell(p: ProcessDetail | undefined): string {
  if (!p) return "…";
  const runs = currentRuns(p.detail);
  if (!runs.length) return "—";
  return [...new Set(runs.map(r => r.modelIdentity?.resolvedModelId ?? "unknown"))].join("+");
}

/** Tokens used / cap from the plane's budget read. A run without usage accounting is unknown, not zero. */
export function tokensCell(p: ProcessDetail | undefined): string {
  if (!p) return "…";
  if (!p.detail.runs.length) return "—";
  const b = p.budget;
  if (b === "off" || b === "unavailable") return "unknown";
  if (!b.runs.length || b.runs.some(r => r.accounting === "none")) return "unknown";
  const cap = b.latestRevision?.caps.max_tokens ?? b.caps.max_tokens;
  return `${kTok(b.consumed.tokens)}${cap !== undefined ? `/${kTok(cap)}` : ""}`;
}

/** Provider-reported activity (`activity_phase`), verbatim. Not a plane stage: only adapters that report one fill it. */
export function phaseCell(task: Mission): string {
  return task.phase || "—";
}

const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

/**
 * The budget read's cost, never computed here: `$x` measured, `~$x` estimated, `unknown` when the
 * plane says unknown or, like TOKENS, any run has no usage accounting.
 */
export function costCell(p: ProcessDetail | undefined): string {
  if (!p) return "…";
  if (!p.detail.runs.length) return "—";
  const b = p.budget;
  if (b === "off" || b === "unavailable") return "unknown";
  if (!b.runs.length || b.runs.some(r => r.accounting === "none")) return "unknown";
  const { costMethod, costUsd } = b.consumed;
  if (!Number.isFinite(costUsd)) return "unknown";
  if (costMethod === "measured") return usd(costUsd);
  if (costMethod === "estimated") return `~${usd(costUsd)}`;
  return "unknown";
}

/** Context pressure from the plane's K9 read: a percent only for a known observation; stale is flagged. */
export function ctxCell(p: ProcessDetail | undefined): { text: string; stale: boolean } {
  const none = { text: "—", stale: false };
  if (!p) return { text: "…", stale: false };
  const c = p.context;
  if (!c || c === "unavailable" || c.status !== "known" || !c.observation) return none;
  const { pressure, freshness } = c.observation;
  if (typeof pressure !== "number" || !Number.isFinite(pressure) || pressure < 0) return none;
  return { text: `${Math.round(pressure * 100)}%`, stale: freshness !== "live" };
}

const CHECK_MARK = { passed: "✓", failed: "✗", blocked: "⊘" } as const;

/** Verification counts of the last run: `n✓` passed, `n✗` failed, `n⊘` blocked; skipped is not counted. */
export function checksCell(p: ProcessDetail | undefined): { text: string; title: string } {
  const none = { text: "—", title: "" };
  if (!p) return { text: "…", title: "" };
  const last = p.detail.runs.at(-1);
  if (!last || !last.ended_at) return none;
  if (p.session === "unavailable") return { text: "unknown", title: "session read failed" };
  const checks = p.session?.result?.verification?.checks;
  if (!checks?.length) return none;
  const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const c of checks) counts[verificationCheckView(c).label] += 1;
  const text = (["passed", "failed", "blocked"] as const).filter(k => counts[k]).map(k => `${counts[k]}${CHECK_MARK[k]}`).join(" ");
  const title = (Object.keys(counts) as Array<keyof typeof counts>).filter(k => counts[k]).map(k => `${counts[k]} ${k}`).join(", ");
  return { text: text || "—", title };
}

/**
 * Why a NEEDS-YOU row needs you, from reads the shell already makes: a pending approval (and its
 * tool), a limit pause, a recovery offer, or a blocked verification check. Null when none is known.
 */
export function causeCell(task: Mission, p: ProcessDetail | undefined): string | null {
  if (processState(task) !== "NEEDS-YOU") return null;
  const attention = p?.attention && p.attention !== "unavailable" ? p.attention : null;
  const approval = attention?.approvals[0];
  if (attention && approval) {
    const more = attention.approvals.length - 1;
    return `approve: ${approval.tool ?? "unknown tool"}${more > 0 ? ` (+${more})` : ""}`;
  }
  if (missionState(task) === "LIMIT_PAUSED") return "limit paused";
  if (attention?.restartOffered) return "restart offered";
  if (checksCell(p).text.includes(CHECK_MARK.blocked)) return "verify: blocked";
  return null;
}

/** The same rule as `useRestartOffered`: a live session of this task whose audit records a `resume_offered` recovery decision. */
export function restartOfferedIn(taskId: string, state: string, sessions: SessionDetail[]): boolean {
  return state === "WAITING_INPUT" && sessions.some(s => !s.endedAt && s.taskId === taskId && s.audit.some(e =>
    e.type === "recovery.decision" && (e.payload as { action?: string } | null)?.action === "resume_offered"));
}

/** Tool names by approval request id, from the task's `approval.requested` events. */
export function approvalTools(events: TaskEvent[]): Map<string, string | null> {
  const tools = new Map<string, string | null>();
  for (const e of events) {
    if (e.type !== "approval.requested") continue;
    const payload = e.payload as { requestId?: unknown; tool?: unknown } | null;
    if (typeof payload?.requestId === "string") tools.set(payload.requestId, typeof payload.tool === "string" && payload.tool ? payload.tool : null);
  }
  return tools;
}

export function toRow(task: Mission, p: ProcessDetail | undefined, now: number): ProcessRow {
  const ctx = ctxCell(p);
  const checks = checksCell(p);
  return {
    pid: task.id,
    state: processState(task),
    rawState: missionState(task),
    phase: phaseCell(task),
    assistant: assistantCell(p),
    model: modelCell(p),
    tokens: tokensCell(p),
    cost: costCell(p),
    ctx: ctx.text,
    ctxStale: ctx.stale,
    checks: checks.text,
    checksTitle: checks.title,
    age: formatAge(task.createdAt, now),
    goal: task.goal,
    cause: causeCell(task, p),
    task,
  };
}

/** `wide` columns leave the table at phone width; the detail pane header shows them for the selected row. */
export const COLUMNS = [
  ["pid", "PID", false],
  ["state", "STATE", false],
  ["phase", "PHASE", true],
  ["assistant", "ASSIST", true],
  ["model", "MODEL", true],
  ["tokens", "TOKENS", false],
  ["cost", "COST", true],
  ["ctx", "CTX", true],
  ["checks", "CHECKS", true],
  ["age", "AGE", true],
  ["goal", "GOAL", false],
] as const;
export type SortKey = (typeof COLUMNS)[number][0];
export interface Sort { key: SortKey | null; dir: 1 | -1 }

/** NEEDS-YOU first, always. Then the chosen column, else state rank and most recently updated. */
export function sortRows(rows: ProcessRow[], sort: Sort): ProcessRow[] {
  const value = (r: ProcessRow): string | number => {
    switch (sort.key) {
      case "age": return Date.parse(r.task.createdAt);
      case "tokens": return Number.parseFloat(r.tokens) * (r.tokens.includes("k") ? 1000 : 1) || -1;
      case "cost": return Number.parseFloat(r.cost.replace(/^~?\$/, "")) || -1;
      case "ctx": return Number.parseFloat(r.ctx) || -1;
      case null: return 0;
      default: return r[sort.key].toLowerCase();
    }
  };
  return rows.slice().sort((a, b) => {
    const pin = Number(b.state === "NEEDS-YOU") - Number(a.state === "NEEDS-YOU");
    if (pin) return pin;
    if (sort.key) {
      const va = value(a), vb = value(b);
      // Age sorts by creation time, so ascending age is descending timestamp.
      const dir = sort.key === "age" ? -sort.dir : sort.dir;
      if (va !== vb) return (va < vb ? -1 : 1) * dir;
    }
    return stateRank(a.task) - stateRank(b.task) || b.task.updatedAt.localeCompare(a.task.updatedAt);
  });
}

/** The highest reported window, or null when the provider reports no limits. */
export function quotaPercent(a: Assistant): number | null {
  const limits = a.manifest?.core.limits ?? [];
  return limits.length ? Math.max(...limits.map(l => l.usedPercent)) : null;
}

/** The CSS quota bar's fill, 0–100. The old glyph bar rendered as empty boxes in headless Chromium, so the bar is drawn, not typed. */
export function quotaFill(percent: number): number {
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0;
}

export function assistantStatus(a: Assistant, cooldowns: Array<{ assistantId: string; until: string }>, now: number): string {
  if (!a.enabled) return "off";
  if (cooldowns.some(c => c.assistantId === a.id && Date.parse(c.until) > now)) return "cooling";
  if (a.manifest && a.manifest.core.auth.state !== "ok") return `auth ${a.manifest.core.auth.state}`;
  return "ready";
}

const two = (n: number) => String(n).padStart(2, "0");
export const clock = (d: Date, seconds = false) =>
  `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ""}`;

/** Oldest first, like `tail -f`. */
export function logLines(events: TaskEvent[], limit = 200) {
  return events
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq)
    .slice(-limit)
    .map(e => ({ key: `${e.run_id}:${e.seq}`, time: clock(new Date(e.ts), true), type: e.type, summary: e.summary }));
}

/** Keys never fire from a text field; Esc is handled by the field itself. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export const KEYMAP: ReadonlyArray<readonly [string, string]> = [
  ["j / k", "move down / up"],
  ["Enter", "open the Inspector"],
  ["/", "focus the command line"],
  ["a", "approve the focused approval"],
  ["d", "deny the focused approval (confirms)"],
  ["c", "cancel the selected task (confirms)"],
  ["h", "hand off the selected task"],
  ["r", "run a waiting task now"],
  ["?", "show or hide this help"],
  ["Esc", "back"],
];
