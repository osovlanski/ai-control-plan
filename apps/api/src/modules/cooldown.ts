import type { Db } from "../db/index.js";

/** Fallback windows when the provider gives us no resets_at to honour. */
const DEFAULT_LIMIT_MS = 60 * 60 * 1000; // an unknown quota window: back off an hour
const DEFAULT_FAILURE_MS = 10 * 60 * 1000;

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
  constructor(private db: Db) {}

  /** `resetsAt` from the provider wins; otherwise a default window by kind. */
  penalize(
    assistantId: string,
    kind: "limit" | "failure",
    reason: string,
    resetsAt?: string,
  ): Cooldown {
    const now = Date.now();
    const parsed = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    const until = new Date(
      Number.isFinite(parsed) && parsed > now
        ? parsed
        : now + (kind === "limit" ? DEFAULT_LIMIT_MS : DEFAULT_FAILURE_MS),
    ).toISOString();

    this.db
      .prepare(
        `INSERT INTO cooldowns (assistant_id, reason, until, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(assistant_id) DO UPDATE SET reason = excluded.reason, until = excluded.until, created_at = excluded.created_at`,
      )
      .run(assistantId, reason, until, new Date(now).toISOString());

    return { assistantId, reason, until };
  }

  /** Active cooldowns as router hard-filter reasons, keyed by assistant. */
  active(now: Date = new Date()): Map<string, string> {
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
