-- B2 remote auth (docs/adr/remote-auth-design.md, amendments D-A/D-B).
--
-- Remote browser sessions for the second, remote-only loopback listener (the Tailscale Serve
-- target). Only a sha256 of the random 256-bit cookie handle is stored, never the handle. The
-- principal is the exact pinned (issuer, subject) pair; `workspace` is the boot-selected workspace.
-- Times are epoch milliseconds. A row is valid while `revoked_at` is NULL, now < `absolute_expires_at`
-- and now < `last_active_at` + idle TTL. Boot revokes every open row (restart policy).
CREATE TABLE remote_sessions (
  handle_hash TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  workspace TEXT NOT NULL,
  grants_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT
);
CREATE INDEX idx_remote_sessions_open ON remote_sessions(revoked_at, absolute_expires_at);

-- One row per pending login: five minutes, single use, bound to the browser by a random
-- `__Host-acp_login` cookie whose sha256 is `browser_hash`. `state` is looked up; the cookie must match.
-- `nonce` and `code_verifier` go to the IdP exchange and are deleted with the row.
CREATE TABLE remote_login_transactions (
  state TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_remote_login_transactions_expiry ON remote_login_transactions(expires_at);
