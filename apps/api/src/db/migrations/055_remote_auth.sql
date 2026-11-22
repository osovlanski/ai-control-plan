-- B2 remote auth (docs/adr/remote-auth-design.md, stage 2, one-origin amendments).
--
-- Browser sessions minted only by the remote listener after an OIDC login that matched the exact
-- (iss, sub) owner pin. Only a sha256 of the cookie handle is stored, never the handle, an IdP
-- token or an email. `principal` is a pseudonym: sha256 of "iss\nsub". `workspace_id` is the
-- boot-selected workspace directory identity; a row never authorizes another instance.
-- Times are epoch milliseconds. A boot revokes every live row (reason 'restart').

CREATE TABLE remote_sessions (
  id TEXT PRIMARY KEY,
  handle_hash TEXT NOT NULL UNIQUE,
  principal TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  last_interactive_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT CHECK (revoked_reason IN ('logout','revoke_all','restart','relogin'))
);
CREATE INDEX idx_remote_sessions_live ON remote_sessions(revoked_at, absolute_expires_at);

-- One pending login per browser transaction cookie: consumed exactly once by the callback, or
-- pruned at expiry. `browser_hash` binds it to the __Host-acp_login cookie; the PKCE verifier and
-- nonce live only here, for at most the transaction TTL.
CREATE TABLE remote_login_transactions (
  state TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  -- The remote session this browser held when it started the login (re-login rotates: the old one is revoked).
  replaces_session_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Login abuse counters survive a restart, so a restart is never a free reset of the login budget.
-- `bucket` is 'login:instance' or 'login:addr:<sha256 of the verified client address>'.
CREATE TABLE remote_auth_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
