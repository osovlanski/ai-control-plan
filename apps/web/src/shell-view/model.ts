import type { Assistant, CompositionBudget, TaskDetail, TaskEvent } from "../api.js";
import { missionState, type Mission } from "../board/execution.js";

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

/** The plane's per-task reads behind one row. `budget: "off"` = composer disabled, `"unavailable"` = read failed. */
export interface ProcessDetail {
  detail: TaskDetail;
  budget: CompositionBudget | "off" | "unavailable";
}

export interface ProcessRow {
  pid: string;
  state: ProcessState;
  rawState: string;
  assistant: string;
  model: string;
  tokens: string;
  age: string;
  goal: string;
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

export function toRow(task: Mission, p: ProcessDetail | undefined, now: number): ProcessRow {
  return {
    pid: task.id,
    state: processState(task),
    rawState: missionState(task),
    assistant: assistantCell(p),
    model: modelCell(p),
    tokens: tokensCell(p),
    age: formatAge(task.createdAt, now),
    goal: task.goal,
    task,
  };
}

export const COLUMNS = [
  ["pid", "PID"],
  ["state", "STATE"],
  ["assistant", "ASSIST"],
  ["model", "MODEL"],
  ["tokens", "TOKENS"],
  ["age", "AGE"],
  ["goal", "GOAL"],
] as const;
export type SortKey = (typeof COLUMNS)[number][0];
export interface Sort { key: SortKey | null; dir: 1 | -1 }

/** NEEDS-YOU first, always. Then the chosen column, else state rank and most recently updated. */
export function sortRows(rows: ProcessRow[], sort: Sort): ProcessRow[] {
  const value = (r: ProcessRow): string | number => {
    switch (sort.key) {
      case "age": return Date.parse(r.task.createdAt);
      case "tokens": return Number.parseFloat(r.tokens) * (r.tokens.includes("k") ? 1000 : 1) || -1;
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

export function quotaBar(percent: number | null, cells = 4): string {
  if (percent === null) return "unknown";
  const filled = Math.min(cells, Math.max(0, Math.round((percent / 100) * cells)));
  return "▮".repeat(filled) + "▯".repeat(cells - filled);
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
