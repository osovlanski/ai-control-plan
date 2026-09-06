import { EVIDENCE_PRIORITY, type AssistantId, type CapabilityManifest, type QuotaBlocker, type QuotaObservation } from '@agent-plane/core';
import type { Db } from '../db/index.js';

const FRESH_MS = 15 * 60_000;
export const retryDelay = (attempt: number, transient = false): number =>
  (transient ? [1, 3, 10] : [10, 30, 60])[Math.min(2, Math.max(0, attempt))]! * 60_000;

/** A reset is a recheck deadline, never an observation of recovered headroom. */
export class QuotaProjection {
  constructor(private db: Db, private now: () => Date = () => new Date()) {}
  for(assistantId: string, manifest: CapabilityManifest | null, attempt = 0) {
    const observations: QuotaObservation[] = (manifest?.core.limits ?? []).map(q => ({
      assistantId: assistantId as AssistantId, scope: { account: manifest?.core.auth.account, bucket: q.window },
      usedPercent: q.usedPercent, resetsAt: q.resetsAt, source: q.source, observedAt: q.observedAt,
    }));
    const rows = this.db.prepare('SELECT * FROM quota_snapshots WHERE assistant_id = ? ORDER BY observed_at, id').all(assistantId) as Array<{
      window: string; account: string | null; used_percent: number; resets_at: string | null; source: QuotaObservation['source']; observed_at: string;
    }>;
    for (const q of rows) observations.push({ assistantId: assistantId as AssistantId,
      scope: { account: q.account ?? undefined, bucket: q.window }, usedPercent: q.used_percent,
      resetsAt: q.resets_at ?? undefined, source: q.source, observedAt: q.observed_at });
    const buckets = new Map<string, QuotaObservation>();
    for (const q of observations) {
      if (!Number.isFinite(Date.parse(q.observedAt))) continue;
      const key = JSON.stringify([q.scope.account ?? null, q.scope.bucket ?? null]);
      const old = buckets.get(key);
      if (!old || Date.parse(q.observedAt) > Date.parse(old.observedAt) ||
          (q.observedAt === old.observedAt && EVIDENCE_PRIORITY[q.source] >= EVIDENCE_PRIORITY[old.source])) buckets.set(key, q);
    }
    const now = this.now().getTime();
    const fresh = [...buckets.values()].filter(q => now - Date.parse(q.observedAt) <= FRESH_MS &&
      (!q.resetsAt || Date.parse(q.resetsAt) > now));
    const blockers: QuotaBlocker[] = fresh.filter(q => (q.usedPercent ?? 0) >= 100).map(q => ({
      assistantId: assistantId as AssistantId, scope: q.scope, observedAt: q.observedAt, source: q.source,
      kind: q.resetsAt ? 'provider-reset' : 'inferred-backoff',
      retryAt: q.resetsAt ?? new Date(now + retryDelay(attempt)).toISOString(),
      resetProvenance: q.resetsAt ? 'provider-reported' : 'inferred', reason: 'quota exhausted',
    }));
    const cooldown = this.db.prepare('SELECT * FROM cooldowns WHERE assistant_id = ?').get(assistantId) as {
      account: string | null; bucket: string | null; until: string; created_at: string; reason: string; kind: QuotaBlocker['kind']; source: QuotaBlocker['source']; reset_provenance: QuotaBlocker['resetProvenance'];
    } | undefined;
    if (cooldown && Date.parse(cooldown.until) > now && !fresh.some(q => q.scope.account === (cooldown.account ?? undefined) && q.scope.bucket === (cooldown.bucket ?? undefined) && Date.parse(q.observedAt) > Date.parse(cooldown.created_at) && (q.usedPercent ?? 100) < 100)) {
      blockers.push({ assistantId: assistantId as AssistantId, scope: { account: cooldown.account ?? undefined, bucket: cooldown.bucket ?? undefined }, kind: cooldown.kind,
        source: cooldown.source, observedAt: cooldown.created_at, retryAt: cooldown.until,
        resetProvenance: cooldown.reset_provenance, reason: cooldown.reason });
    }
    return { observations: [...buckets.values()], blockers,
      quota: fresh.length ? [...fresh].sort((a,b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0)).map(q => ({ usedPercent: q.usedPercent ?? 0, resetsAt: q.resetsAt }))[0] : undefined };
  }
}

/** Latest bucket per candidate, earliest candidate; callers supply non-quota eligible IDs. */
export function controllingRetry(blockers: QuotaBlocker[], candidates: string[]): string | undefined {
  const instants = candidates.map(id => {
    const own = blockers.filter(b => b.assistantId === id);
    if (!own.length || own.some(b => b.kind === 'intervention-required' || b.kind === 'unknown-recovery')) return undefined;
    const times = own.map(b => Date.parse(b.retryAt));
    return times.every(Number.isFinite) ? Math.max(...times) : undefined;
  }).filter((t): t is number => t !== undefined);
  return instants.length ? new Date(Math.min(...instants)).toISOString() : undefined;
}
