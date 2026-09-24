-- Durable session-addressed conversational input (docs/contracts/session-input.md).
--
-- Three tables, one job each:
--   session_inputs         the LOGICAL message — exactly one row per client key
--   session_input_attempts one row per dispatch attempt, never rewritten
--   session_input_events   the normalized trace, written in the state-change txn
--
-- Nothing reads or writes these tables unless `sessionInput.enabled` is true in
-- the workspace config. The migration is unconditional so that turning the flag
-- on later never needs a schema step, and so an operator who turns it off again
-- keeps the audit history.
CREATE TABLE session_inputs (
  id                   TEXT PRIMARY KEY,
  -- Authority, not a hint: derived from the server's workspace, never the body.
  -- A row whose workspace is not the running one is invisible to every read.
  workspace            TEXT NOT NULL,
  session_id           TEXT NOT NULL REFERENCES runs(id),
  task_id              TEXT NOT NULL REFERENCES tasks(id),
  -- Client-generated BEFORE the first request and reused for every retry.
  client_message_id    TEXT NOT NULL,
  -- Digest of the submitted payload. The same key with different text is a
  -- client bug (409), not a retry, so the two cases stay distinguishable.
  payload_fingerprint  TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK(kind = 'text'),
  text                 TEXT NOT NULL,
  actor                TEXT NOT NULL,
  state                TEXT NOT NULL CHECK(state IN ('queued','accepted','delivered','rejected','expired')),
  reason               TEXT,
  -- Set when an attempt ended send-before-ack. `accepted` + this flag is the
  -- truthful "we cannot tell" state; it is never collapsed into delivered or
  -- rejected, and it is cleared only by real reconciliation evidence.
  delivery_unknown     INTEGER NOT NULL DEFAULT 0 CHECK(delivery_unknown IN (0,1)),
  -- Optimistic-concurrency token returned to clients and required by recovery
  -- commands, so a stale UI cannot act on a state it never saw.
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  expires_at           TEXT,
  -- A message that reached the provider always keeps its receipt evidence.
  provider_receipt     TEXT,
  -- delivered is only ever reached through a provider-level acknowledgement.
  CHECK(state <> 'delivered' OR provider_receipt IS NOT NULL),
  -- Uncertainty belongs to a dispatched message, never to a queued one.
  CHECK(delivery_unknown = 0 OR state = 'accepted'),
  UNIQUE(workspace, session_id, client_message_id)
);
CREATE INDEX idx_session_inputs_session ON session_inputs(session_id, created_at, id);
-- The recovery sweep's read: everything not yet settled.
CREATE INDEX idx_session_inputs_open ON session_inputs(state) WHERE state IN ('queued','accepted');

CREATE TABLE session_input_attempts (
  attempt_id         TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL REFERENCES session_inputs(id),
  ordinal            INTEGER NOT NULL CHECK(ordinal > 0),
  -- The dispatcher incarnation that owns this attempt. A restart takes a new
  -- epoch, which is how an in-flight attempt from a dead owner is recognised
  -- as unknown instead of being silently resumed.
  lease_epoch        TEXT NOT NULL,
  adapter            TEXT NOT NULL,
  capability_version TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  outcome            TEXT NOT NULL CHECK(outcome IN ('in_flight','delivered','rejected','unknown')),
  -- Normalized provider reference only. No credentials, no raw responses.
  provider_receipt   TEXT,
  -- Bounded diagnostic code, not a provider error body.
  diagnostic         TEXT,
  CHECK(outcome <> 'delivered' OR provider_receipt IS NOT NULL),
  UNIQUE(message_id, ordinal)
);
CREATE INDEX idx_session_input_attempts_message ON session_input_attempts(message_id, ordinal);
CREATE INDEX idx_session_input_attempts_live ON session_input_attempts(lease_epoch) WHERE outcome = 'in_flight';

-- A separate ledger for the same reason scheduler_events is one: these events
-- exist before and independently of provider run events, so they must not be
-- squeezed into the per-run normalized `events` stream and fabricate a seq.
CREATE TABLE session_input_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL CHECK(type IN (
               'input.queued','input.accepted','input.delivered',
               'input.rejected','input.expired','input.delivery_unknown')),
  message_id TEXT NOT NULL REFERENCES session_inputs(id),
  attempt_id TEXT REFERENCES session_input_attempts(attempt_id),
  session_id TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  workspace  TEXT NOT NULL,
  actor      TEXT NOT NULL,
  at         TEXT NOT NULL,
  reason     TEXT
);
CREATE INDEX idx_session_input_events_message ON session_input_events(message_id, id);
CREATE INDEX idx_session_input_events_session ON session_input_events(session_id, id);
