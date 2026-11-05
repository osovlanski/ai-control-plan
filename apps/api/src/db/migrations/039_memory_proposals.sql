-- O6 S5 — memory proposals (docs/agentic-os-o6-memory-writeback.md §2.3; contract
-- docs/contracts/memory-v1.md). 038 is reserved for M6 S4's shadow log.
--
-- One row per entry the plane parsed from a settled composed session's `agent-plane-memory`
-- block and kept. A proposal is never a write: nothing here touches operator memory. Rows are
-- append-only, like asset_usage: a re-derivation that differs is a conflict the writer counts,
-- never an overwrite (and never INSERT OR REPLACE, whose delete skips triggers).
CREATE TABLE memory_proposals (
  proposal_id             TEXT PRIMARY KEY CHECK(proposal_id GLOB 'mp1_*'),
  ingest_seq              INTEGER NOT NULL UNIQUE CHECK(ingest_seq >= 1),
  session_id              TEXT NOT NULL REFERENCES runs(id),
  task_id                 TEXT NOT NULL REFERENCES tasks(id),
  composition_revision_id TEXT NOT NULL REFERENCES agent_specs(composition_revision_id),
  checkpoint_id           TEXT NOT NULL REFERENCES checkpoints(id),
  entry_index             INTEGER NOT NULL CHECK(entry_index >= 0),
  harness                 TEXT NOT NULL CHECK(harness IN ('claude-code', 'codex', 'cursor', 'bedrock')),
  model                   TEXT,
  kind                    TEXT NOT NULL CHECK(kind IN ('decision', 'gotcha', 'fact')),
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL,
  body                    TEXT NOT NULL,
  target_bundle_id        TEXT,
  target_bundle_digest    TEXT,
  supersedes_json         TEXT NOT NULL,
  outcome                 TEXT NOT NULL CHECK(outcome = 'success'),
  verification_passed     INTEGER CHECK(verification_passed IN (0, 1)),
  changed_files           INTEGER NOT NULL CHECK(changed_files >= 0),
  parser_version          INTEGER NOT NULL,
  body_digest             TEXT NOT NULL,
  at                      TEXT NOT NULL,
  CHECK((target_bundle_id IS NULL) = (target_bundle_digest IS NULL)),
  UNIQUE (session_id, entry_index)
);
CREATE INDEX idx_memory_proposals_task ON memory_proposals(task_id);
CREATE TRIGGER memory_proposals_immutable BEFORE UPDATE ON memory_proposals
BEGIN SELECT RAISE(ABORT, 'memory_proposals rows are immutable'); END;
CREATE TRIGGER memory_proposals_undeletable BEFORE DELETE ON memory_proposals
BEGIN SELECT RAISE(ABORT, 'memory_proposals rows are immutable'); END;

-- Extraction ledger: every settled composed session is evaluated once, with or without a block,
-- so the boot backfill knows what is done. Dropped entries are stored as counts by reason only,
-- never their text (the text that tripped a guard is exactly what must not be stored).
CREATE TABLE memory_proposal_sessions (
  session_id              TEXT PRIMARY KEY REFERENCES runs(id),
  composition_revision_id TEXT NOT NULL REFERENCES agent_specs(composition_revision_id),
  status                  TEXT NOT NULL CHECK(status IN ('proposed', 'skipped')),
  skip_reason             TEXT CHECK(skip_reason IN ('not_completion', 'not_success', 'ambient', 'no_block')),
  proposals               INTEGER NOT NULL CHECK(proposals >= 0),
  dropped_json            TEXT NOT NULL,
  truncated               INTEGER NOT NULL CHECK(truncated >= 0),
  untargeted              INTEGER NOT NULL CHECK(untargeted >= 0),
  parser_version          INTEGER NOT NULL,
  body_digest             TEXT NOT NULL,
  at                      TEXT NOT NULL,
  CHECK((status = 'skipped') = (skip_reason IS NOT NULL))
);
CREATE TRIGGER memory_proposal_sessions_immutable BEFORE UPDATE ON memory_proposal_sessions
BEGIN SELECT RAISE(ABORT, 'memory_proposal_sessions rows are immutable'); END;
CREATE TRIGGER memory_proposal_sessions_undeletable BEFORE DELETE ON memory_proposal_sessions
BEGIN SELECT RAISE(ABORT, 'memory_proposal_sessions rows are immutable'); END;
