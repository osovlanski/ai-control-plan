/**
 * P1-2: "% of estimated scope". An estimate, not a measure: backlog sizes are S=1, M=3, L=8 points (plan §C.3),
 * an item counts as done only when its `os/<id>` PR is merged, and the total is whatever the backlog holds now.
 * Pure: the dispatcher supplies the items and what GitHub said about each.
 */
import type { BacklogItem } from "./autopilot-dispatcher.js";

export const SIZE_POINTS: Readonly<Record<string, number>> = { S: 1, M: 3, L: 8 };
export type ScopeState = "done" | "in review" | "remaining" | "unknown";

export interface ScopeItem { id: string; title: string; phase: string; size: string; points: number; state: ScopeState }
export interface ScopeSummary {
  /** Always true: the figure rests on S/M/L size guesses, not measured effort. */
  estimate: true;
  totalPoints: number; donePoints: number; inReviewPoints: number; remainingPoints: number;
  /** Rounded whole percent of donePoints over totalPoints; 0 for an empty backlog. */
  percentDone: number;
  items: number; done: number; inReview: number; remaining: number;
  /** Items whose PRs could not be read (repo not configured, GitHub error): counted as remaining points, listed here. */
  unknown: string[];
  /** Items with a size outside S/M/L: they carry 0 points and are listed so the total is not silently low. */
  unsized: string[];
  byPhase: { phase: string; totalPoints: number; donePoints: number; percentDone: number }[];
  /** Items in the backlog now that were not in it at the start of the day, with their points. */
  addedToday?: { ids: string[]; points: number };
}

const pct = (done: number, total: number): number => (total > 0 ? Math.round((done / total) * 100) : 0);

export function summariseScope(items: BacklogItem[], states: ReadonlyMap<string, ScopeState>, dayStartIds?: ReadonlySet<string>): { summary: ScopeSummary; items: ScopeItem[] } {
  const rows: ScopeItem[] = items.map((i) => ({ id: i.id, title: i.title, phase: i.phase, size: i.size, points: SIZE_POINTS[i.size] ?? 0, state: states.get(i.id) ?? "unknown" }));
  const sum = (pred: (r: ScopeItem) => boolean) => rows.filter(pred).reduce((n, r) => n + r.points, 0);
  const totalPoints = sum(() => true);
  const donePoints = sum((r) => r.state === "done");
  const inReviewPoints = sum((r) => r.state === "in review");
  const phases = [...new Set(rows.map((r) => r.phase))];
  const added = dayStartIds ? rows.filter((r) => !dayStartIds.has(r.id)) : undefined;
  return {
    items: rows,
    summary: {
      estimate: true, totalPoints, donePoints, inReviewPoints, remainingPoints: totalPoints - donePoints - inReviewPoints,
      percentDone: pct(donePoints, totalPoints),
      items: rows.length, done: rows.filter((r) => r.state === "done").length, inReview: rows.filter((r) => r.state === "in review").length,
      remaining: rows.filter((r) => r.state === "remaining" || r.state === "unknown").length,
      unknown: rows.filter((r) => r.state === "unknown").map((r) => r.id),
      unsized: rows.filter((r) => !(r.size in SIZE_POINTS)).map((r) => r.id),
      byPhase: phases.map((phase) => {
        const t = rows.filter((r) => r.phase === phase).reduce((n, r) => n + r.points, 0);
        const d = rows.filter((r) => r.phase === phase && r.state === "done").reduce((n, r) => n + r.points, 0);
        return { phase, totalPoints: t, donePoints: d, percentDone: pct(d, t) };
      }),
      ...(added ? { addedToday: { ids: added.map((r) => r.id), points: added.reduce((n, r) => n + r.points, 0) } } : {}),
    },
  };
}

export function renderScope(s: ScopeSummary, day: string): string {
  const out = [
    `Scope (estimate) ${day}: ${s.percentDone}% done — ${s.donePoints} of ${s.totalPoints} points (S=1, M=3, L=8)`,
    `  ${s.done} items merged, ${s.inReview} in review (${s.inReviewPoints} pts), ${s.remaining} remaining (${s.remainingPoints} pts)`,
    ...s.byPhase.map((p) => `  ${p.phase}: ${p.percentDone}% (${p.donePoints}/${p.totalPoints})`),
  ];
  if (s.addedToday) out.push(`  added since the start of the day: ${s.addedToday.ids.length} items, ${s.addedToday.points} pts${s.addedToday.ids.length ? ` (${s.addedToday.ids.join(", ")})` : ""}`);
  if (s.unknown.length) out.push(`  could not be read (counted as remaining): ${s.unknown.join(", ")}`);
  if (s.unsized.length) out.push(`  no S/M/L size (0 points): ${s.unsized.join(", ")}`);
  return out.join("\n");
}
