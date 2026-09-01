/**
 * Quota snapshots feed router eligibility + cooldowns. Both the legacy
 * `Orchestrator.applyEvent` path and the flag-ON `EventRecorder.afterInsertInTx`
 * hook write them, so the extraction lives here (PLAN.md 8d).
 *
 * Writes `quota_snapshots` only — never `runs` (that column is the fenced
 * session CAS's alone, Codex R2 #5).
 */
import type { NormalizedEvent } from "@agent-plane/core";
import type { Db } from "../../db/index.js";

export function quotaOf(
  event: NormalizedEvent,
): Array<{ window: string; usedPercent: number; resetsAt?: string }> | undefined {
  const quota = (
    event.payload as { quota?: Array<{ window: string; usedPercent: number; resetsAt?: string }> } | undefined
  )?.quota;
  return quota && quota.length > 0 ? quota : undefined;
}

export function snapshotQuota(db: Db, assistantId: string, event: NormalizedEvent): void {
  const quota = quotaOf(event);
  if (!quota) return;
  const insert = db.prepare(
    "INSERT INTO quota_snapshots (assistant_id, window, used_percent, resets_at, source, observed_at) VALUES (?, ?, ?, ?, 'runtime-probe', ?)",
  );
  for (const q of quota) {
    insert.run(assistantId, q.window, q.usedPercent, q.resetsAt ?? null, event.ts);
  }
}
