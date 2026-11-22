import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../../db/index.js";

/**
 * The single writer for remote browser sessions and pending OIDC logins (migration 055). Only
 * hashes of cookie values and CSRF tokens are stored. Every lookup re-validates expiry,
 * revocation, workspace and the current owner pin, so a row can never outlive its policy.
 */
export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"); const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
/** Pseudonym of an OIDC identity: never the subject or email in clear. */
export const principalOf = (issuer: string, subject: string) => sha256(`${issuer}\n${subject}`);

export interface RemoteSessionRow {
  id: string; handle_hash: string; principal: string; workspace_id: string; csrf_hash: string;
  issued_at: number; last_interactive_at: number; absolute_expires_at: number; revoked_at: number | null; revoked_reason: string | null;
}

export type SessionCheck =
  | { ok: true; row: RemoteSessionRow; idleExpiresAt: number }
  | { ok: false; reason: "unknown" | "revoked" | "expired_absolute" | "expired_idle" | "workspace" | "principal" };

export interface LoginTransaction { state: string; browser_hash: string; nonce: string; code_verifier: string; replaces_session_id: string | null; created_at: number; expires_at: number }

export class RemoteSessionStore {
  constructor(private readonly db: Db, private readonly o: { workspaceId: string; principal: string; idleMs: number; absoluteMs: number; now: () => Date }) {}

  private nowMs() { return this.o.now().getTime(); }

  /** Boot policy: every remote session from a previous process is revoked and pending logins dropped. */
  revokeOnBoot(): number {
    const now = this.nowMs();
    this.db.prepare("DELETE FROM remote_login_transactions").run();
    return this.db.prepare("UPDATE remote_sessions SET revoked_at = ?, revoked_reason = 'restart' WHERE revoked_at IS NULL").run(now).changes;
  }

  mint(): { id: string; handle: string; csrf: string; row: RemoteSessionRow } {
    const now = this.nowMs();
    const id = `rs_${randomToken(12)}`; const handle = randomToken(32); const csrf = randomToken(32);
    const row: RemoteSessionRow = {
      id, handle_hash: sha256(handle), principal: this.o.principal, workspace_id: this.o.workspaceId, csrf_hash: sha256(csrf),
      issued_at: now, last_interactive_at: now, absolute_expires_at: now + this.o.absoluteMs, revoked_at: null, revoked_reason: null,
    };
    this.db.prepare(`INSERT INTO remote_sessions (id, handle_hash, principal, workspace_id, csrf_hash, issued_at, last_interactive_at, absolute_expires_at)
      VALUES (@id, @handle_hash, @principal, @workspace_id, @csrf_hash, @issued_at, @last_interactive_at, @absolute_expires_at)`).run(row);
    return { id, handle, csrf, row };
  }

  byHandle(handle: string): SessionCheck {
    const row = this.db.prepare("SELECT * FROM remote_sessions WHERE handle_hash = ?").get(sha256(handle)) as RemoteSessionRow | undefined;
    return row ? this.check(row) : { ok: false, reason: "unknown" };
  }

  byId(id: string): SessionCheck {
    const row = this.db.prepare("SELECT * FROM remote_sessions WHERE id = ?").get(id) as RemoteSessionRow | undefined;
    return row ? this.check(row) : { ok: false, reason: "unknown" };
  }

  private check(row: RemoteSessionRow): SessionCheck {
    const now = this.nowMs();
    if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
    if (now >= row.absolute_expires_at) return { ok: false, reason: "expired_absolute" };
    const idleExpiresAt = Math.min(row.last_interactive_at + this.o.idleMs, row.absolute_expires_at);
    if (now >= idleExpiresAt) return { ok: false, reason: "expired_idle" };
    if (row.workspace_id !== this.o.workspaceId) return { ok: false, reason: "workspace" };
    if (row.principal !== this.o.principal) return { ok: false, reason: "principal" };
    return { ok: true, row, idleExpiresAt };
  }

  csrfMatches(row: RemoteSessionRow, token: string): boolean { return safeEqualHex(row.csrf_hash, sha256(token)); }

  /** Operator interaction only (CSRF-checked requests). Never moves past the absolute deadline. */
  touch(id: string): void {
    this.db.prepare("UPDATE remote_sessions SET last_interactive_at = ? WHERE id = ? AND revoked_at IS NULL").run(this.nowMs(), id);
  }

  revoke(id: string, reason: "logout" | "relogin"): boolean {
    return this.db.prepare("UPDATE remote_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL").run(this.nowMs(), reason, id).changes === 1;
  }

  revokeAll(): number {
    return this.db.prepare("UPDATE remote_sessions SET revoked_at = ?, revoked_reason = 'revoke_all' WHERE revoked_at IS NULL").run(this.nowMs()).changes;
  }

  liveCount(): number {
    const now = this.nowMs();
    return (this.db.prepare("SELECT COUNT(*) AS n FROM remote_sessions WHERE revoked_at IS NULL AND absolute_expires_at > ?").get(now) as { n: number }).n;
  }

  // ---- pending logins ----

  pruneLogins(): void { this.db.prepare("DELETE FROM remote_login_transactions WHERE expires_at <= ?").run(this.nowMs()); }
  pendingLogins(): number { return (this.db.prepare("SELECT COUNT(*) AS n FROM remote_login_transactions").get() as { n: number }).n; }

  beginLogin(ttlMs: number, replacesSessionId: string | null): { state: string; browserSecret: string; nonce: string; verifier: string } {
    const now = this.nowMs();
    const t = { state: randomToken(24), browserSecret: randomToken(32), nonce: randomToken(24), verifier: randomToken(48) };
    this.db.prepare(`INSERT INTO remote_login_transactions (state, browser_hash, nonce, code_verifier, replaces_session_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(t.state, sha256(t.browserSecret), t.nonce, t.verifier, replacesSessionId, now, now + ttlMs);
    return t;
  }

  /**
   * Consumes the transaction atomically (it is deleted whatever the outcome, so a callback can
   * never be replayed), then checks the browser binding and expiry.
   */
  consumeLogin(state: string, browserSecret: string): LoginTransaction | undefined {
    const row = this.db.prepare("DELETE FROM remote_login_transactions WHERE state = ? RETURNING *").get(state) as LoginTransaction | undefined;
    if (!row) return undefined;
    if (!safeEqualHex(row.browser_hash, sha256(browserSecret))) return undefined;
    if (this.nowMs() >= row.expires_at) return undefined;
    return row;
  }

  // ---- persistent login budget ----

  /** Counts one attempt in a fixed window and returns the new count. Throws on store failure (callers fail closed). */
  countAttempt(bucket: string, windowMs: number): { count: number; retryAfterSeconds: number } {
    const now = this.nowMs();
    const windowStart = now - (now % windowMs);
    this.db.prepare("DELETE FROM remote_auth_limits WHERE window_start < ?").run(windowStart - windowMs);
    const row = this.db.prepare(`INSERT INTO remote_auth_limits (bucket, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count`).get(bucket, windowStart) as { count: number };
    return { count: row.count, retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) };
  }
}
