import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import type { Scope } from "../contract.js";

/**
 * OAuth state for the MCP authorization server, in its own SQLite file (never the plane database).
 * Every secret value (client secret, code, access/refresh token) is stored only as a SHA-256 hash.
 */
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const ACCESS_TTL_MS = 15 * 60_000;
export const CODE_TTL_MS = 60_000;
export const GRANT_TTL_MS = 30 * 24 * 3_600_000;
export const PENDING_TTL_MS = 10 * 60_000;
export const UNUSED_CLIENT_TTL_MS = 24 * 3_600_000;

export interface ClientRow {
  client_id: string; kind: "dcr" | "cimd"; client_name: string; redirect_uris: string; auth_method: string;
  secret_hash: string | null; created_at: number; last_used_at: number | null;
}
export interface GrantRow { id: string; client_id: string; scopes: string; resource: string; created_at: number; expires_at: number; revoked_at: number | null }
export interface PendingRow {
  id: string; browser_hash: string; client_id: string; redirect_uri: string; state: string | null; scopes: string; resource: string;
  code_challenge: string; oidc_nonce: string; oidc_verifier: string; owner_ok: number; csrf: string | null; created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY, kind TEXT NOT NULL, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
  auth_method TEXT NOT NULL, secret_hash TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS consents (client_id TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (client_id));
CREATE TABLE IF NOT EXISTS pending (
  id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT,
  scopes TEXT NOT NULL, resource TEXT NOT NULL, code_challenge TEXT NOT NULL, oidc_nonce TEXT NOT NULL, oidc_verifier TEXT NOT NULL,
  owner_ok INTEGER NOT NULL DEFAULT 0, csrf TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, grant_id TEXT);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access','refresh')), grant_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL, spent_at INTEGER);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens(grant_id);
`;

export class OAuthStore {
  readonly db: Database.Database;
  constructor(path: string, private readonly now: () => number = Date.now) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  // ---- clients ----
  addClient(row: Omit<ClientRow, "created_at" | "last_used_at">) {
    this.db.prepare(`INSERT INTO clients (client_id, kind, client_name, redirect_uris, auth_method, secret_hash, created_at)
      VALUES (@client_id, @kind, @client_name, @redirect_uris, @auth_method, @secret_hash, @created_at)
      ON CONFLICT(client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris`)
      .run({ ...row, created_at: this.now() });
  }
  client(id: string): ClientRow | undefined {
    return this.db.prepare("SELECT * FROM clients WHERE client_id = ?").get(id) as ClientRow | undefined;
  }
  touchClient(id: string) { this.db.prepare("UPDATE clients SET last_used_at = ? WHERE client_id = ?").run(this.now(), id); }
  /**
   * DCR registrations never used within 24 hours are deleted (ADR). A CIMD row is only a cache of a
   * fetched document (authorize refetches it every time), so once no pending authorization, live
   * code or live grant refers to it, it is deleted too: an abandoned CIMD authorize leaves nothing.
   */
  pruneClients() {
    const t = this.now();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM clients WHERE kind = 'dcr' AND last_used_at IS NULL AND created_at < ?").run(t - UNUSED_CLIENT_TTL_MS);
      this.db.prepare("DELETE FROM pending WHERE created_at < ?").run(t - PENDING_TTL_MS);
      this.db.prepare("DELETE FROM codes WHERE expires_at < ?").run(t - GRANT_TTL_MS);
      this.db.prepare(`DELETE FROM clients WHERE kind = 'cimd' AND created_at < @cutoff
        AND NOT EXISTS (SELECT 1 FROM pending p WHERE p.client_id = clients.client_id)
        AND NOT EXISTS (SELECT 1 FROM codes c WHERE c.client_id = clients.client_id AND c.used_at IS NULL AND c.expires_at >= @t)
        AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.client_id = clients.client_id AND g.revoked_at IS NULL AND g.expires_at > @t)`)
        .run({ cutoff: t - PENDING_TTL_MS, t });
      this.db.prepare("DELETE FROM consents WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.client_id = consents.client_id)").run();
    })();
  }

  // ---- consent ----
  consented(clientId: string, scopes: Scope[]): boolean {
    const row = this.db.prepare("SELECT scopes FROM consents WHERE client_id = ?").get(clientId) as { scopes: string } | undefined;
    if (!row) return false;
    const held = new Set(row.scopes.split(" "));
    return scopes.every((s) => held.has(s));
  }
  recordConsent(clientId: string, scopes: Scope[]) {
    this.db.prepare("INSERT INTO consents (client_id, scopes, created_at) VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET scopes = excluded.scopes, created_at = excluded.created_at")
      .run(clientId, scopes.join(" "), this.now());
  }

  // ---- pending authorizations (browser leg) ----
  addPending(row: Omit<PendingRow, "owner_ok" | "csrf" | "created_at">) {
    this.db.prepare(`INSERT INTO pending (id, browser_hash, client_id, redirect_uri, state, scopes, resource, code_challenge, oidc_nonce, oidc_verifier, created_at)
      VALUES (@id, @browser_hash, @client_id, @redirect_uri, @state, @scopes, @resource, @code_challenge, @oidc_nonce, @oidc_verifier, @created_at)`)
      .run({ ...row, created_at: this.now() });
  }
  pending(id: string): PendingRow | undefined {
    const row = this.db.prepare("SELECT * FROM pending WHERE id = ?").get(id) as PendingRow | undefined;
    if (row && this.now() - row.created_at > PENDING_TTL_MS) { this.dropPending(id); return undefined; }
    return row;
  }
  markOwner(id: string, csrf: string) { this.db.prepare("UPDATE pending SET owner_ok = 1, csrf = ? WHERE id = ?").run(csrf, id); }
  dropPending(id: string) { this.db.prepare("DELETE FROM pending WHERE id = ?").run(id); }

  // ---- codes ----
  issueCode(p: { clientId: string; redirectUri: string; scopes: string; resource: string; codeChallenge: string }): string {
    const code = token();
    this.db.prepare(`INSERT INTO codes (code_hash, client_id, redirect_uri, scopes, resource, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(hash(code), p.clientId, p.redirectUri, p.scopes, p.resource, p.codeChallenge, this.now() + CODE_TTL_MS);
    return code;
  }
  /**
   * Redeems a code once. A second redemption revokes the grant the first one created (OAuth 2.1 §4.1.3).
   */
  redeemCode(code: string): { kind: "ok"; row: { client_id: string; redirect_uri: string; scopes: string; resource: string; code_challenge: string } } | { kind: "invalid" } {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM codes WHERE code_hash = ?").get(hash(code)) as
        { code_hash: string; client_id: string; redirect_uri: string; scopes: string; resource: string; code_challenge: string; expires_at: number; used_at: number | null; grant_id: string | null } | undefined;
      if (!row) return { kind: "invalid" as const };
      if (row.used_at !== null) { if (row.grant_id) this.revokeGrant(row.grant_id); return { kind: "invalid" as const }; }
      this.db.prepare("UPDATE codes SET used_at = ? WHERE code_hash = ?").run(this.now(), row.code_hash);
      if (row.expires_at < this.now()) return { kind: "invalid" as const };
      return { kind: "ok" as const, row };
    })();
  }
  bindCodeGrant(code: string, grantId: string) { this.db.prepare("UPDATE codes SET grant_id = ? WHERE code_hash = ?").run(grantId, hash(code)); }

  // ---- grants and tokens ----
  createGrant(clientId: string, scopes: string, resource: string): string {
    const id = `g_${token(12)}`;
    const t = this.now();
    this.db.prepare("INSERT INTO grants (id, client_id, scopes, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, clientId, scopes, resource, t, t + GRANT_TTL_MS);
    return id;
  }
  grant(id: string): GrantRow | undefined { return this.db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as GrantRow | undefined; }
  revokeGrant(id: string) {
    this.db.prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(this.now(), id);
    this.db.prepare("DELETE FROM tokens WHERE grant_id = ?").run(id);
  }
  /** Mints an access token and a refresh token for a live grant. */
  issueTokens(grantId: string): { access: string; refresh: string; expiresIn: number } {
    const access = token(); const refresh = token();
    const g = this.grant(grantId)!;
    const t = this.now();
    const ins = this.db.prepare("INSERT INTO tokens (token_hash, kind, grant_id, expires_at) VALUES (?, ?, ?, ?)");
    ins.run(hash(access), "access", grantId, Math.min(t + ACCESS_TTL_MS, g.expires_at));
    ins.run(hash(refresh), "refresh", grantId, g.expires_at);
    return { access, refresh, expiresIn: Math.floor((Math.min(t + ACCESS_TTL_MS, g.expires_at) - t) / 1000) };
  }
  /**
   * Rotates a refresh token. Presenting a spent refresh token revokes the whole grant (reuse detection).
   */
  rotateRefresh(refresh: string, clientId: string): { kind: "ok"; grantId: string } | { kind: "invalid" } | { kind: "reused" } {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash(refresh)) as
        { token_hash: string; grant_id: string; expires_at: number; spent_at: number | null } | undefined;
      if (!row) return { kind: "invalid" as const };
      const g = this.grant(row.grant_id);
      if (!g || g.revoked_at !== null || g.client_id !== clientId) return { kind: "invalid" as const };
      if (row.spent_at !== null) { this.revokeGrant(g.id); return { kind: "reused" as const }; }
      if (row.expires_at < this.now() || g.expires_at < this.now()) return { kind: "invalid" as const };
      this.db.prepare("UPDATE tokens SET spent_at = ? WHERE token_hash = ?").run(this.now(), row.token_hash);
      return { kind: "ok" as const, grantId: g.id };
    })();
  }
  /** The live grant an access token belongs to, or undefined. */
  verifyAccess(access: string): GrantRow | undefined {
    const row = this.db.prepare("SELECT grant_id, expires_at FROM tokens WHERE token_hash = ? AND kind = 'access'").get(hash(access)) as
      { grant_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= this.now()) return undefined;
    const g = this.grant(row.grant_id);
    if (!g || g.revoked_at !== null || g.expires_at <= this.now()) return undefined;
    return g;
  }

  /** `revoke --all`: every grant, token, consent and client. */
  revokeAll(): { grants: number; clients: number } {
    return this.db.transaction(() => {
      const grants = this.db.prepare("UPDATE grants SET revoked_at = ? WHERE revoked_at IS NULL").run(this.now()).changes;
      this.db.prepare("DELETE FROM tokens").run();
      this.db.prepare("DELETE FROM codes").run();
      this.db.prepare("DELETE FROM pending").run();
      this.db.prepare("DELETE FROM consents").run();
      const clients = this.db.prepare("DELETE FROM clients").run().changes;
      return { grants, clients };
    })();
  }
}
