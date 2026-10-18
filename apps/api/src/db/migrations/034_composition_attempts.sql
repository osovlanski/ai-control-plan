-- M2 Composer — attempt log and per-task asset opt-ins (docs/plans/m2-composer.md §3).
--
-- composition_attempts records every composition attempt, including the ones
-- that produced no revision, so "why did this run have no composition" has an
-- answer without a revision to hang it on. A revision (agent_specs, 033) exists
-- only when a Cockpit render succeeded; an attempt exists always.
--   persisted  a revision was written; composition_revision_id names it
--   failed     the pipeline could not produce a revision; reason says why
--   skipped    the pipeline did not apply (e.g. an unsupported harness); reason says why
-- routing_decision_id and composition_digest are NULL when the attempt stopped
-- before routing or before a digest could be computed.
CREATE TABLE composition_attempts (
  id                      TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL REFERENCES tasks(id),
  origin                  TEXT NOT NULL,
  routing_decision_id     INTEGER REFERENCES routing_decisions(id),
  composition_digest      TEXT,
  outcome                 TEXT NOT NULL CHECK(outcome IN ('persisted', 'failed', 'skipped')),
  reason                  TEXT,
  composition_revision_id TEXT REFERENCES agent_specs(composition_revision_id),
  created_at              TEXT NOT NULL,
  -- A revision id exists exactly when the attempt persisted one.
  CHECK((outcome = 'persisted') = (composition_revision_id IS NOT NULL)),
  -- A non-persisted attempt must say why; that is the table's reason to exist.
  CHECK(outcome = 'persisted' OR (reason IS NOT NULL AND length(reason) > 0))
);
CREATE INDEX idx_composition_attempts_task ON composition_attempts(task_id);

-- An operator's per-task opt-in to attach one registry asset at one digest.
-- `at` is stamped once, here, so recomposing reads the opt-in as an input
-- instead of restamping it. A changed digest is a different row, never an edit.
CREATE TABLE composition_opt_ins (
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  asset_id TEXT NOT NULL,
  digest   TEXT NOT NULL,
  actor    TEXT NOT NULL,
  at       TEXT NOT NULL,
  UNIQUE(task_id, asset_id, digest)
);

-- Append-only, as 033: there is no UPDATE or DELETE path.
CREATE TRIGGER composition_attempts_immutable BEFORE UPDATE ON composition_attempts
BEGIN SELECT RAISE(ABORT, 'composition_attempts rows are immutable'); END;
CREATE TRIGGER composition_attempts_undeletable BEFORE DELETE ON composition_attempts
BEGIN SELECT RAISE(ABORT, 'composition_attempts rows are immutable'); END;
CREATE TRIGGER composition_opt_ins_immutable BEFORE UPDATE ON composition_opt_ins
BEGIN SELECT RAISE(ABORT, 'composition_opt_ins rows are immutable'); END;
CREATE TRIGGER composition_opt_ins_undeletable BEFORE DELETE ON composition_opt_ins
BEGIN SELECT RAISE(ABORT, 'composition_opt_ins rows are immutable'); END;
