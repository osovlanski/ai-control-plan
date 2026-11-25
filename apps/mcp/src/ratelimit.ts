/** Fixed-window counters, in memory. A restart forgets them; that is accepted for one owner. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one hit against every (key, limit, windowMs) given. All must pass, or none is counted. */
  hit(...checks: Array<{ key: string; limit: number; windowMs: number }>): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const t = this.now();
    let wait = 0;
    for (const c of checks) {
      const w = this.windows.get(c.key);
      if (w && t - w.start < c.windowMs && w.count >= c.limit) wait = Math.max(wait, Math.ceil((w.start + c.windowMs - t) / 1000));
    }
    if (wait > 0) return { ok: false, retryAfterSeconds: Math.min(3600, Math.max(1, wait)) };
    for (const c of checks) {
      const w = this.windows.get(c.key);
      if (!w || t - w.start >= c.windowMs) this.windows.set(c.key, { start: t, count: 1 });
      else w.count += 1;
    }
    if (this.windows.size > 10_000) this.prune(t);
    return { ok: true };
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) if (t - w.start > 3_600_000) this.windows.delete(k);
  }
}
