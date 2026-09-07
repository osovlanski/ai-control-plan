import type { TaskEvent, TaskWait } from "./api.js";
import { missionState, type ExecutionRead } from "./board/execution.js";

/** Presentation vocabulary only; this does not extend the kernel state machine. */
export function describeState(state: string, pauseKind?: string | null) {
  const states: Record<
    string,
    { label: string; reason: string; tone: string }
  > = {
    CREATED: {
      label: "Ready to route",
      reason: "Created; no execution has started.",
      tone: "neutral",
    },
    ROUTING: {
      label: "Choosing environment",
      reason: "The control plane evaluates eligible assistants.",
      tone: "active",
    },
    RUNNING: {
      label: "Running",
      reason: "Execution is in progress.",
      tone: "active",
    },
    AWAITING_APPROVAL: {
      label: "Approval required",
      reason: "A session is waiting for your approval. The task remains RUNNING; the paused session is not executing.",
      tone: "human",
    },
    RUNTIME_UNKNOWN: {
      label: "Runtime unknown",
      reason: "Task state is RUNNING, but session-level execution and approval visibility is unavailable on this read or execution path. Inspect recorded events and full controls.",
      tone: "neutral",
    },
    WAITING_RESOURCE: {
      label: "Scheduler wait",
      reason:
        "The scheduler owns this task (K1/K2). It holds a durable wait condition and wakes at the next eligible time; a quota wait revalidates provider evidence before it re-routes.",
      tone: "resource",
    },
    WAITING_INPUT: {
      label: "Needs you",
      reason: "A human decision is required. This is not a scheduler wait.",
      tone: "human",
    },
    LIMIT_PAUSED: {
      label: "Limit paused",
      reason:
        "Execution hit a provider limit. K2 checkpoints the run and parks it as a scheduler quota wait; if the wake budget is exhausted it lands here for an operator decision.",
      tone: "limit",
    },
    HANDING_OFF: {
      label: "Handing off",
      reason: "Control is transferring between execution environments.",
      tone: "handoff",
    },
    COMPLETED: {
      label: "Completed",
      reason: "The task is complete.",
      tone: "complete",
    },
    FAILED: {
      label: "Failed",
      reason: "Execution ended in failure. Inspect events and verification.",
      tone: "failed",
    },
    CANCELLED: {
      label: "Cancelled",
      reason: "The task was cancelled.",
      tone: "neutral",
    },
  };
  const pauses: Record<string, string> = {
    approval_pending: "Approval required",
    verification_failed: "Verification decision",
    comparison_pending: "Comparison decision",
    handoff_requested: "Handoff decision",
    limit: "Limit — operator decision",
    intervention_required: "Intervention required",
    no_candidate: "No eligible assistant",
  };
  const value = states[state] ?? {
    label: state,
    reason: "Unrecognized state reported by the API.",
    tone: "neutral",
  };
  return state === "WAITING_INPUT" && pauseKind && pauses[pauseKind]
    ? { ...value, label: pauses[pauseKind]! }
    : value;
}

/** Human label for a durable wait condition's kind (K1 time vs K2 quota). */
export function waitKindLabel(wait: Pick<TaskWait, "kind">): string {
  return wait.kind === "quota"
    ? "Quota wait · K2"
    : wait.kind === "time"
      ? "Time wait · K1"
      : wait.kind === "dependency"
        ? "Dependency wait · K4"
        : `Wait · ${wait.kind}`;
}

/** Coarse freshness bucket for an idle quota probe attempt age (K3). */
export function probeFreshness(ageMs: number): "live" | "recent" | "stale" {
  if (ageMs < 5 * 60_000) return "live";
  if (ageMs < 20 * 60_000) return "recent";
  return "stale";
}

/** Resolve only from this run's persisted provider start evidence, never discovery/catalog aliases. */
export function observedModel(
  events: TaskEvent[],
  runId: string | undefined,
): string {
  if (!runId) return "Unknown";
  const start = events.find(
    (e) =>
      e.run_id === runId &&
      e.type === "run.started" &&
      typeof e.payload?.model === "string",
  );
  return typeof start?.payload?.model === "string"
    ? start.payload.model
    : "Unknown";
}

export interface ContextView {
  occupancyTokens?: number;
  effectiveWindowTokens?: number;
  advertisedMaxTokens?: number;
  occupancySource: "provider-reported" | "estimated" | "unavailable";
  freshness: "live" | "stale" | "unavailable";
  observedAt?: string;
  estimator?: { name: string; version: string };
}
export function contextPercent(observation: ContextView): number | undefined {
  const { occupancyTokens: used, effectiveWindowTokens: capacity } =
    observation;
  return observation.freshness === "live" &&
    observation.occupancySource !== "unavailable" &&
    used !== undefined &&
    Number.isFinite(used) &&
    used >= 0 &&
    capacity !== undefined &&
    Number.isFinite(capacity) &&
    capacity > 0
    ? Math.round((used / capacity) * 100)
    : undefined;
}

/* ---------------------------------------------------------------------------
 * Orbital field geometry. Pure functions; the field component only renders.
 * All coordinates are in a 1000×1000 scene; callers scale to pixels.
 * ------------------------------------------------------------------------- */

/** Which orbit a task sits on. Ring is a state group, angle is an index —
 * neither is a forecast of when anything will happen. */
export type Ring = 0 | 1 | 2;
export const SCENE = 1000;
export const SPHERE_R = 210;
export const RINGS: ReadonlyArray<{ rx: number; ry: number; rot: number }> = [
  { rx: 312, ry: 142, rot: -24 }, // in motion: ROUTING / RUNNING / HANDING_OFF
  { rx: 385, ry: 158, rot: -9 }, // held: WAITING_RESOURCE / WAITING_INPUT / LIMIT_PAUSED / CREATED
  { rx: 462, ry: 262, rot: 19 }, // settled: COMPLETED / FAILED / CANCELLED
];
const HELD = new Set(["WAITING_RESOURCE", "WAITING_INPUT", "AWAITING_APPROVAL", "RUNTIME_UNKNOWN", "LIMIT_PAUSED", "CREATED"]);
const SETTLED = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
export function ringOf(state: string): Ring {
  return SETTLED.has(state) ? 2 : HELD.has(state) ? 1 : 0;
}

const SAMPLES = 360;
const arcTables = RINGS.map(({ rx, ry }) => {
  // cumulative arc length, so a fraction p maps to the same point that
  // CSS `offset-distance: p%` reaches along the identical path.
  const lengths = [0];
  let prev = [rx, 0];
  for (let i = 1; i <= SAMPLES; i++) {
    const a = (i / SAMPLES) * Math.PI * 2;
    const pt = [rx * Math.cos(a), ry * Math.sin(a)];
    lengths.push(lengths[i - 1]! + Math.hypot(pt[0]! - prev[0]!, pt[1]! - prev[1]!));
    prev = pt;
  }
  return lengths;
});
/** Point on ring `ring` at arc-length fraction `p` (0..1), scene coordinates. */
export function pointAt(ring: Ring, p: number): { x: number; y: number } {
  const { rx, ry, rot } = RINGS[ring]!;
  const table = arcTables[ring]!;
  const target = ((p % 1) + 1) % 1 * table[SAMPLES]!;
  let i = 1;
  while (i < SAMPLES && table[i]! < target) i++;
  const span = table[i]! - table[i - 1]!;
  const t = (i - 1 + (span ? (target - table[i - 1]!) / span : 0)) / SAMPLES;
  const a = t * Math.PI * 2;
  const x = rx * Math.cos(a);
  const y = ry * Math.sin(a);
  const r = (rot * Math.PI) / 180;
  return {
    x: SCENE / 2 + x * Math.cos(r) - y * Math.sin(r),
    y: SCENE / 2 + x * Math.sin(r) + y * Math.cos(r),
  };
}
/** Closed elliptical path for a ring, scaled by `scale`, starting at p=0. */
export function ringPath(ring: Ring, scale = 1): string {
  const { rx, ry, rot } = RINGS[ring]!;
  const a = pointAt(ring, 0);
  const b = pointAt(ring, 0.5);
  const f = (n: number) => (n * scale).toFixed(2);
  return `M ${f(a.x)} ${f(a.y)} A ${f(rx)} ${f(ry)} ${rot} 0 1 ${f(b.x)} ${f(b.y)} A ${f(rx)} ${f(ry)} ${rot} 0 1 ${f(a.x)} ${f(a.y)}`;
}
/** Open arc along a ring from fraction `from` spanning `length`, as a polyline. */
export function arcPath(ring: Ring, from: number, length: number, scale = 1): string {
  const steps = 24;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const { x, y } = pointAt(ring, from + (length * i) / steps);
    return `${i ? "L" : "M"} ${(x * scale).toFixed(2)} ${(y * scale).toFixed(2)}`;
  }).join(" ");
}

export interface Body<T extends { id: string; state: string }> {
  task: T;
  ring: Ring;
  /** Arc-length fraction along the ring. */
  phase: number;
  /** Label on the left of the dot (true) or the right (false). */
  flip: boolean;
}
const LABEL_W = 150; // scene units: label box reach from the dot, on its label side
const LABEL_H = 26;
/** Labels point away from the sphere unless that would leave the scene. */
function flipFor(x: number, reach = LABEL_W): boolean {
  return x < SCENE / 2 ? x > reach + 28 : x > SCENE - reach - 28;
}
/** Executing bodies drift ±DRIFT of the ring around their slot (see `orbit-drift`). */
export const DRIFT = 0.025;
const MOVING = new Set(["RUNNING", "ROUTING", "HANDING_OFF"]);
function box(b: { ring: Ring; phase: number; task: { state: string } }, scale = 1) {
  const { x, y } = pointAt(b.ring, b.phase);
  const reach = LABEL_W / scale;
  const flip = flipFor(x, reach);
  const pad = MOVING.has(b.task.state) ? 60 : 0;
  return {
    x0: (flip ? x - reach : x - 14) - pad,
    x1: (flip ? x + 14 : x + reach) + pad,
    y0: y - LABEL_H / scale - pad / 2,
    y1: y + LABEL_H / scale + pad / 2,
  };
}
/** True when two placed bodies' label boxes intersect (exported for tests). */
export function bodiesCollide(a: Body<{ id: string; state: string }>, b: Body<{ id: string; state: string }>, scale = 1): boolean {
  const p = box(a, scale);
  const q = box(b, scale);
  return p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;
}
/** Deterministic placement: tasks share a ring by state group and are spaced
 * evenly along it in list order, then nudged apart where label boxes collide. */
export function layoutBodies<T extends { id: string; state: string }>(tasks: T[], scale = 1): Body<T>[] {
  const byRing: T[][] = [[], [], []];
  for (const t of tasks) byRing[ringOf(missionState(t))]!.push(t);
  const out: Body<T>[] = [];
  byRing.forEach((group, ring) => {
    const start = [0.86, 0.2, 0.55][ring]!;
    group.forEach((task, i) => {
      out.push({ task, ring: ring as Ring, phase: (start + i / group.length) % 1, flip: false });
    });
  });
  // ponytail: O(n²) pairwise separation; fine for the ≤8 bodies the board shows.
  for (let pass = 0; pass < 14; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        if (bodiesCollide(out[i]!, out[j]!, scale)) {
          out[j]!.phase = (out[j]!.phase + 0.03) % 1;
          moved = true;
        }
      }
    if (!moved) break;
  }
  for (const b of out) b.flip = flipFor(pointAt(b.ring, b.phase).x, LABEL_W / scale);
  return out;
}

/** Bound density using the rendered label footprint, keeping selection first.
 * Missions that do not fit remain accessible in the register. */
export function visibleBodies<T extends { id: string; state: string }>(tasks: T[], selectedId: string | null, scale: number): Body<T>[] {
  const placed: Body<T>[] = [];
  const candidates = layoutBodies(tasks, scale).sort((a, b) => Number(b.task.id === selectedId) - Number(a.task.id === selectedId));
  for (const body of candidates) {
    if (placed.every(other => !bodiesCollide(body, other, scale))) placed.push(body);
  }
  return placed;
}

export interface FieldPulse {
  running: number;
  attention: number;
  waiting: number;
  ready: number;
  unknown: number;
  settled: number;
  total: number;
}
/** Workload summary that drives the core ring and the system health pill. */
export function fieldPulse(tasks: Array<{ state: string; execution?: ExecutionRead }>): FieldPulse {
  const pulse = { running: 0, attention: 0, waiting: 0, ready: 0, unknown: 0, settled: 0, total: tasks.length };
  for (const task of tasks) {
    const state = missionState(task);
    if (state === "RUNNING" || state === "ROUTING" || state === "HANDING_OFF") pulse.running++;
    else if (state === "WAITING_INPUT" || state === "LIMIT_PAUSED" || state === "AWAITING_APPROVAL") pulse.attention++;
    else if (state === "WAITING_RESOURCE") pulse.waiting++;
    else if (state === "CREATED") pulse.ready++;
    else if (state === "RUNTIME_UNKNOWN") pulse.unknown++;
    else pulse.settled++;
  }
  return pulse;
}

/** "What happens next" — derived only from persisted K1–K3 truth. */
export function nextStep(input: {
  state: string;
  wait?: Pick<TaskWait, "kind" | "notBefore"> | null;
  schedulerEnabled?: boolean;
  assistant?: string | null;
  pauseKind?: string | null;
}): string {
  const { state, wait } = input;
  if (state === "AWAITING_APPROVAL") return "Waits for your approval; open full controls, then Sessions to review the pending request.";
  if (state === "RUNTIME_UNKNOWN") return "Inspect full controls and recorded events; the next runtime action cannot be confirmed.";
  if (state === "WAITING_RESOURCE" && wait) {
    if (input.schedulerEnabled === false) return "Scheduling is disabled; waits until an operator runs it now.";
    const at = new Date(wait.notBefore).toLocaleString();
    return wait.kind === "quota"
      ? `Wakes at ${at}, revalidates quota evidence, then re-routes from its checkpoint.`
      : `Scheduler wakes it at ${at} and dispatches once.`;
  }
  if (state === "WAITING_INPUT")
    return input.pauseKind === "approval_pending"
      ? "Waits for your approval; nothing runs until you decide."
      : "Waits for your decision; the scheduler will not wake it.";
  if (state === "LIMIT_PAUSED") return "Paused at a limit; inspect quota and recovery evidence for the next action.";
  if (state === "RUNNING") return `Executing on ${input.assistant ?? "the routed assistant"}; events stream in below.`;
  if (state === "ROUTING") return "The router is evaluating eligible assistants.";
  if (state === "HANDING_OFF") return "Control transfers to another execution environment.";
  if (state === "CREATED") return "Route it to preview which assistant it would run on.";
  if (state === "COMPLETED") return "Settled. History stays inspectable.";
  if (state === "FAILED") return "Settled in failure; inspect events and verification.";
  if (state === "CANCELLED") return "Retired without further execution.";
  return "Unknown state; no next step can be derived.";
}
