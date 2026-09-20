-- Explicit retry/cancel commands and scheduler-owned redelivery
-- (docs/contracts/session-input.md).
--
-- Two schema facts change, and both need a table rebuild because SQLite cannot
-- widen a CHECK or replace an implicit UNIQUE in place. The 023 pattern is
-- repeated: rebuild under deferred foreign keys, verify the graph, clear it.
--
--   1. A retry of a REJECTED message is a new row in the same retry chain, not
--      a resurrected terminal record. `rejected` stays terminal exactly as the
--      state machine proved it, the settled row keeps its identity and its
--      trace, and the successor inherits the client key and the payload
--      fingerprint — so the chain is still one logical message to its client.
--      The uniqueness key therefore gains `generation`, and that unique index
--      is also the fence: two concurrent retries of the same row compute the
--      same next generation, so exactly one of them can create it.
--   2. The command trace events (`input.retry_requested`, `input.cancelled`)
--      join the normalized event vocabulary. They are intents, recorded even
--      when they change no state; any state change still emits its own event.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE session_inputs_r2 (
  id                   TEXT PRIMARY KEY,
  workspace            TEXT NOT NULL,
  session_id           TEXT NOT NULL REFERENCES runs(id),
  task_id              TEXT NOT NULL REFERENCES tasks(id),
  client_message_id    TEXT NOT NULL,
  payload_fingerprint  TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK(kind = 'text'),
  text                 TEXT NOT NULL,
  actor                TEXT NOT NULL,
  state                TEXT NOT NULL CHECK(state IN ('queued','accepted','delivered','rejected','expired')),
  reason               TEXT,
  delivery_unknown     INTEGER NOT NULL DEFAULT 0 CHECK(delivery_unknown IN (0,1)),
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  expires_at           TEXT,
  provider_receipt     TEXT,
  -- Which incarnation of the client key this row is. 1 is the original submit;
  -- every explicit retry of a rejected row adds one. A client that resubmits
  -- its key resolves to the newest generation, which is the live incarnation.
  generation           INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  -- The settled row this one retries. Never rewritten, so the whole chain stays
  -- walkable from either end.
  retry_of             TEXT REFERENCES session_inputs(id),
  CHECK(state <> 'delivered' OR provider_receipt IS NOT NULL),
  CHECK(delivery_unknown = 0 OR state = 'accepted'),
  -- Only an original has no predecessor.
  CHECK(generation = 1 OR retry_of IS NOT NULL),
  UNIQUE(workspace, session_id, client_message_id, generation)
);
INSERT INTO session_inputs_r2
  (id, workspace, session_id, task_id, client_message_id, payload_fingerprint, kind, text, actor,
   state, reason, delivery_unknown, version, created_at, updated_at, expires_at, provider_receipt)
  SELECT id, workspace, session_id, task_id, client_message_id, payload_fingerprint, kind, text, actor,
         state, reason, delivery_unknown, version, created_at, updated_at, expires_at, provider_receipt
    FROM session_inputs;
DROP TABLE session_inputs;
ALTER TABLE session_inputs_r2 RENAME TO session_inputs;
CREATE INDEX idx_session_inputs_session ON session_inputs(session_id, created_at, id);
CREATE INDEX idx_session_inputs_open ON session_inputs(state) WHERE state IN ('queued','accepted');
-- Scheduler-owned redelivery reads exactly this: the still-queued messages of
-- one task. The index is created with the rebuild rather than in a later
-- migration so the table is never rebuilt twice for one slice.
CREATE INDEX idx_session_inputs_task_queued ON session_inputs(task_id) WHERE state = 'queued';
CREATE INDEX idx_session_inputs_retry ON session_inputs(retry_of) WHERE retry_of IS NOT NULL;

CREATE TABLE session_input_events_r2 (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL CHECK(type IN (
               'input.queued','input.accepted','input.delivered',
               'input.rejected','input.expired','input.delivery_unknown',
               'input.retry_requested','input.cancelled')),
  message_id TEXT NOT NULL REFERENCES session_inputs(id),
  attempt_id TEXT REFERENCES session_input_attempts(attempt_id),
  session_id TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  workspace  TEXT NOT NULL,
  actor      TEXT NOT NULL,
  at         TEXT NOT NULL,
  reason     TEXT
);
INSERT INTO session_input_events_r2
  (id, type, message_id, attempt_id, session_id, task_id, workspace, actor, at, reason)
  SELECT id, type, message_id, attempt_id, session_id, task_id, workspace, actor, at, reason
    FROM session_input_events;
DROP TABLE session_input_events;
ALTER TABLE session_input_events_r2 RENAME TO session_input_events;
CREATE INDEX idx_session_input_events_message ON session_input_events(message_id, id);
CREATE INDEX idx_session_input_events_session ON session_input_events(session_id, id);

CREATE TEMP TABLE session_input_commands_fk_check (violations INTEGER NOT NULL CHECK(violations = 0));
INSERT INTO session_input_commands_fk_check SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE session_input_commands_fk_check;
PRAGMA defer_foreign_keys = OFF;
