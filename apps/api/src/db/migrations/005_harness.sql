-- Execution Harness — Phase 1: schema + session-persistence substrate
-- (docs/execution-harness.md §10, docs/harness-implementation-plan.md Phase 1).
--
-- This migration is ADDITIVE. The legacy `runs.state` vocabulary
-- (STARTING|ACTIVE|ENDED_OK|ENDED_ERROR|CANCELLED) stays authoritative for the
-- existing orchestrator; `runs.session_state` is added alongside and backfilled
-- via the §5 forward map. The destructive vocabulary rewrite + the orchestrator
-- write-path cutover land with the SessionRunner (Phase 3), behind the same
-- dual-field read window this column opens.

-- --- runs becomes the execution-session table (additive columns) --------------
ALTER TABLE runs ADD COLUMN execution_request_id TEXT;
ALTER TABLE runs ADD COLUMN session_state        TEXT;
ALTER TABLE runs ADD COLUMN version              INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN lease_token          TEXT;
ALTER TABLE runs ADD COLUMN lease_expires_at     TEXT;
ALTER TABLE runs ADD COLUMN heartbeat_seq        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN provider_start_acked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cancel_requested     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN settlement_owner     TEXT;
ALTER TABLE runs ADD COLUMN attempt              INTEGER NOT NULL DEFAULT 1;

-- Backfill session_state from the legacy vocabulary (§5 forward map).
UPDATE runs SET session_state = CASE state
  WHEN 'STARTING'     THEN 'STARTING'
  WHEN 'ACTIVE'       THEN 'RUNNING'
  WHEN 'ENDED_OK'     THEN 'COMPLETED'
  WHEN 'ENDED_ERROR'  THEN 'FAILED'
  WHEN 'CANCELLED'    THEN 'CANCELLED'
  ELSE 'FAILED'
END;

-- One session row per accepted request (H-I8). Partial: legacy rows have NULL.
CREATE UNIQUE INDEX uq_runs_execution_request
  ON runs(execution_request_id) WHERE execution_request_id IS NOT NULL;

-- --- execution_requests: immutable record of one request --------------------
-- The rendered prompt is NOT stored (§10): only the canonical provenance object
-- and its fingerprint. An executionRequestId reused with a different fingerprint
-- is rejected as a conflict, never an idempotent retry.
CREATE TABLE execution_requests (
  id                      TEXT PRIMARY KEY,          -- executionRequestId (idempotency key)
  task_id                 TEXT NOT NULL REFERENCES tasks(id),
  attempt                 INTEGER NOT NULL,
  assistant_id            TEXT NOT NULL,
  model                   TEXT,                       -- JSON ModelRef or NULL
  composition_revision_id TEXT,
  routing_decision_ref    TEXT NOT NULL,
  request_fingerprint     TEXT NOT NULL,
  fingerprint_algorithm   TEXT NOT NULL,
  prompt_source           TEXT NOT NULL,              -- fresh | handoff | resume
  prompt_source_ref       TEXT,                       -- checkpoint / envelope id
  template_version        TEXT,
  rendered_prompt_digest  TEXT NOT NULL,
  policy                  TEXT NOT NULL,              -- JSON ExecutionPolicy
  verification            TEXT NOT NULL,              -- JSON VerificationSpec[]
  origin                  TEXT NOT NULL,              -- JSON ExecutionOrigin
  origin_envelope_id      TEXT,                       -- set iff origin.kind = 'handoff'
  superseded              INTEGER NOT NULL DEFAULT 0,
  canonical_projection    TEXT NOT NULL,              -- JSON, the exact fingerprint input
  created_at              TEXT NOT NULL,
  -- Load-bearing cross-table constraints (§10), DB-enforced not convention.
  -- origin must be valid JSON with a known kind, and origin_envelope_id is
  -- present IFF that kind is 'handoff' (both directions; a missing kind fails,
  -- since a NULL sub-expression would otherwise let the CHECK pass).
  CHECK (
    json_valid(origin)
    AND json_extract(origin, '$.kind') IS NOT NULL
    AND json_extract(origin, '$.kind') IN ('fresh', 'resume', 'handoff')
    AND (json_extract(origin, '$.kind') = 'handoff') = (origin_envelope_id IS NOT NULL)
  ),
  CHECK (prompt_source IN ('fresh', 'handoff', 'resume')),
  CHECK (superseded IN (0, 1))
);
CREATE INDEX idx_execution_requests_task ON execution_requests(task_id);

-- Only ONE live (non-superseded) successor per handoff envelope (§7). A released
-- claim marks its request superseded, so a corrected successor is still accepted.
CREATE UNIQUE INDEX uq_live_successor
  ON execution_requests(origin_envelope_id)
  WHERE origin_envelope_id IS NOT NULL AND superseded = 0;

-- --- approvals: durable approval protocol (§4) ------------------------------
CREATE TABLE approvals (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES runs(id),
  provider_request_id TEXT NOT NULL,
  state               TEXT NOT NULL,   -- pending|answered|delivering|delivered|delivery_unknown|expired
  decision            TEXT,            -- approved | denied
  answered_by         TEXT,
  answered_at         TEXT,
  delivered_at        TEXT,
  delivery_note       TEXT,            -- e.g. "unknown" surfaced on session reads
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (session_id, provider_request_id),
  CHECK (state IN ('pending','answered','delivering','delivered','delivery_unknown','expired')),
  CHECK (decision IS NULL OR decision IN ('approved','denied'))
);
CREATE INDEX idx_approvals_session ON approvals(session_id);

-- --- guard_directives: durable directives, committed with their event (§4) --
CREATE TABLE guard_directives (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES runs(id),
  event_seq  INTEGER,                    -- the triggering event, when there is one
  guard      TEXT NOT NULL,              -- budget|timeout|tool|approval|quota
  directive  TEXT NOT NULL,              -- continue|checkpoint|cancel|pause|yield
  payload    TEXT,                       -- JSON directive detail
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | applied | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  CHECK (status IN ('pending','applied','failed'))
);
CREATE INDEX idx_guard_directives_session ON guard_directives(session_id, status);

-- --- execution_results: one row per terminal session, written in the CAS tx --
CREATE TABLE execution_results (
  session_id     TEXT PRIMARY KEY REFERENCES runs(id),
  terminal_state TEXT NOT NULL,
  outcome        TEXT NOT NULL,   -- completed|failed|cancelled|timed_out|yielded
  result         TEXT NOT NULL,   -- JSON ExecutionResult
  at             TEXT NOT NULL,
  CHECK (outcome IN ('completed','failed','cancelled','timed_out','yielded'))
);

-- --- handoff_envelopes: typed envelope rows, persisted consumption protocol -
CREATE TABLE handoff_envelopes (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  checkpoint_id          TEXT NOT NULL REFERENCES checkpoints(id),
  envelope               TEXT NOT NULL,   -- JSON HandoffEnvelope
  state                  TEXT NOT NULL DEFAULT 'ready',   -- ready|claimed|consumed|released
  claimed_by_request_id  TEXT REFERENCES execution_requests(id),
  from_assistant_id      TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  source_session_id      TEXT REFERENCES runs(id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK (state IN ('ready','claimed','consumed','released'))
);
CREATE INDEX idx_handoff_envelopes_task ON handoff_envelopes(task_id);

-- --- checkpoints become session-scoped (§4) -------------------------------
ALTER TABLE checkpoints ADD COLUMN session_id TEXT REFERENCES runs(id);
