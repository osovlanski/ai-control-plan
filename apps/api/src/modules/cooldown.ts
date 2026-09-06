import { retryDelay } from './quota.js';
import type { Db } from "../db/index.js";

/** Fallback windows when the provider gives us no resets_at to honour. */

export interface Cooldown {
  assistantId: string;
  reason: string;
  until: string;
}

/**
 * Routing penalty for an assistant that just hit a limit or failed. Expressed
 * as a hard filter rather than a score penalty so the reason survives into the
 * routing explanation the user reads.
 */
export class CooldownStore {
  /** `now` is the kernel clock the scheduler and quota projection share. */
  constructor(private db: Db, private clock: () => Date = () => new Date()) {}

  /** `resetsAt` from the provider wins; otherwise a default window by kind. */
  penalize(
    assistantId: string,
    kind: "limit" | "failure",
    reason: string,
    resetsAt?: string,
    attempt = 0,
  ): Cooldown {
    const now = this.clock().getTime();
    const parsed = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    const until = new Date(
      Number.isFinite(parsed) && parsed > now
        ? parsed
        : now + retryDelay(attempt, kind === "failure"),
    ).toISOString();

    this.db
      .prepare(
        `INSERT INTO cooldowns (assistant_id, reason, until, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(assistant_id) DO UPDATE SET reason = excluded.reason, until = excluded.until, created_at = excluded.created_at`,
      )
      .run(assistantId, reason, until, new Date(now).toISOString());

    const manifest = this.db.prepare("SELECT json_extract(manifest, '$.core.auth.account') account FROM assistants WHERE id = ?").get(assistantId) as { account: string | null };
    const snapshot = resetsAt ? this.db.prepare('SELECT window FROM quota_snapshots WHERE assistant_id = ? AND resets_at = ? ORDER BY observed_at DESC, id DESC LIMIT 1').get(assistantId, resetsAt) as { window: string } | undefined : undefined;
    this.db.prepare('UPDATE cooldowns SET account = ?, bucket = ? WHERE assistant_id = ?').run(manifest?.account ?? null, snapshot?.window ?? null, assistantId);
    this.db.prepare('UPDATE cooldowns SET kind = ?, source = ?, reset_provenance = ? WHERE assistant_id = ?')
      .run(kind === 'failure' ? 'transient-unavailable' : Number.isFinite(parsed) && parsed > now ? 'provider-reset' : 'inferred-backoff',
        'runtime-probe', Number.isFinite(parsed) && parsed > now ? 'provider-reported' : 'inferred', assistantId);
    return { assistantId, reason, until };
  }

  /** Active cooldowns as router hard-filter reasons, keyed by assistant. */
  active(now: Date = this.clock()): Map<string, string> {
    const rows = this.db
      .prepare("SELECT assistant_id, reason, until FROM cooldowns WHERE until > ?")
      .all(now.toISOString()) as Array<{ assistant_id: string; reason: string; until: string }>;
    return new Map(
      rows.map((r) => [r.assistant_id, `${r.reason} (until ${new Date(r.until).toLocaleTimeString()})`]),
    );
  }

  list(): Cooldown[] {
    return (
      this.db
        .prepare("SELECT assistant_id, reason, until FROM cooldowns ORDER BY until DESC")
        .all() as Array<{ assistant_id: string; reason: string; until: string }>
    ).map((r) => ({ assistantId: r.assistant_id, reason: r.reason, until: r.until }));
  }

  clear(assistantId: string): void {
    this.db.prepare("DELETE FROM cooldowns WHERE assistant_id = ?").run(assistantId);
  }
}
