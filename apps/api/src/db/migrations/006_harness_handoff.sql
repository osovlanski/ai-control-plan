-- Execution Harness — Phase 4: handoff envelope claim protocol
-- (docs/execution-harness.md §7).
--
-- 005 shipped `handoff_envelopes` with state ready|claimed|consumed|released.
-- The claim protocol adds `start_ambiguous` (adapter.start attempted — no
-- automatic expiry release from there, only recovery may settle it) plus the two
-- timestamps recovery probes: `claimed_at` and `start_attempted_at`. SQLite
-- cannot ALTER a CHECK, so the table is rebuilt. It is only ever populated at
-- runtime (no migration seeds it), so on any real DB this runs before the first
-- envelope row exists; the row-copy below covers the paranoid case anyway.

ALTER TABLE handoff_envelopes RENAME TO handoff_envelopes_005;

CREATE TABLE handoff_envelopes (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  checkpoint_id          TEXT NOT NULL REFERENCES checkpoints(id),
  envelope               TEXT NOT NULL,   -- JSON HandoffEnvelope
  -- ready → claimed → consumed ; claimed → released (a pre-start failure keeps
  -- the "had a failed attempt" signal; claim() still accepts 'released');
  -- claimed → start_ambiguous (adapter.start attempted) — no automatic expiry
  -- release from there, only recovery may settle it (§7).
  state                  TEXT NOT NULL DEFAULT 'ready',
  claimed_by_request_id  TEXT REFERENCES execution_requests(id),
  claimed_at             TEXT,
  start_attempted_at     TEXT,
  from_assistant_id      TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  source_session_id      TEXT REFERENCES runs(id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK (state IN ('ready','claimed','start_ambiguous','consumed','released'))
);

INSERT INTO handoff_envelopes
  (id, task_id, checkpoint_id, envelope, state, claimed_by_request_id,
   claimed_at, start_attempted_at, from_assistant_id, reason, source_session_id,
   created_at, updated_at)
SELECT
  id, task_id, checkpoint_id, envelope, state, claimed_by_request_id,
  NULL, NULL, from_assistant_id, reason, source_session_id,
  created_at, updated_at
FROM handoff_envelopes_005;

DROP TABLE handoff_envelopes_005;

CREATE INDEX idx_handoff_envelopes_task ON handoff_envelopes(task_id);
