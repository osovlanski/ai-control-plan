-- M6 S1 — asset usage ledger (docs/agentic-os-m6-composition-telemetry.md §2.1, Q1).
--
-- M1's writer-less asset_usage cannot say "not observable" and has no revision or session, so it
-- is renamed, kept with its triggers and indexes in case a row exists, and a new table takes the
-- name. One row per (revision, session, asset): selected, attached, validated, invoked, outcome.
-- Rows are append-only; a re-derivation that differs is a conflict the writer counts, never an
-- overwrite (and never INSERT OR REPLACE, whose delete skips triggers without recursive_triggers).
ALTER TABLE asset_usage RENAME TO asset_usage_m1;

CREATE TABLE asset_usage (
  event_id                TEXT PRIMARY KEY,
  ingest_seq              INTEGER NOT NULL UNIQUE,
  composition_revision_id TEXT NOT NULL REFERENCES agent_specs(composition_revision_id),
  session_id              TEXT NOT NULL REFERENCES runs(id),
  task_id                 TEXT NOT NULL REFERENCES tasks(id),
  asset_kind              TEXT NOT NULL CHECK(asset_kind IN ('skill', 'mcp_server', 'memory_bundle', 'fragment')),
  asset_id                TEXT NOT NULL,
  asset_digest            TEXT NOT NULL,
  harness                 TEXT NOT NULL,
  fidelity                TEXT NOT NULL CHECK(fidelity IN ('full', 'partial', 'none')),
  attached                INTEGER NOT NULL CHECK(attached IN (0, 1)),
  validation              TEXT NOT NULL CHECK(validation IN ('runtime_confirmed', 'runtime_pending', 'rendered', 'files_verified', 'failed', 'none')),
  invocation_method       TEXT NOT NULL CHECK(invocation_method IN ('tool_event', 'not_applicable', 'not_observable')),
  -- NULL = not observable, which is not 0.
  invocation_count        INTEGER CHECK(invocation_count >= 0),
  invocation_failed       INTEGER CHECK(invocation_failed >= 0),
  session_outcome         TEXT NOT NULL CHECK(session_outcome IN ('success', 'error', 'neutral', 'not_run')),
  verification_passed     INTEGER CHECK(verification_passed IN (0, 1)),
  attribution_method      TEXT NOT NULL,
  deriver_version         INTEGER NOT NULL,
  body_digest             TEXT NOT NULL,
  at                      TEXT NOT NULL,
  UNIQUE (composition_revision_id, session_id, asset_kind, asset_id, asset_digest)
);
CREATE INDEX idx_asset_usage_v2_asset ON asset_usage(asset_id, asset_digest);
CREATE INDEX idx_asset_usage_v2_task ON asset_usage(task_id);
CREATE TRIGGER asset_usage_v2_immutable BEFORE UPDATE ON asset_usage
BEGIN SELECT RAISE(ABORT, 'asset_usage rows are immutable'); END;
CREATE TRIGGER asset_usage_v2_undeletable BEFORE DELETE ON asset_usage
BEGIN SELECT RAISE(ABORT, 'asset_usage rows are immutable'); END;

-- Projection ledger: a session is projected once, even with zero assets, so the boot backfill
-- knows what is done.
CREATE TABLE asset_usage_sessions (
  session_id              TEXT PRIMARY KEY REFERENCES runs(id),
  composition_revision_id TEXT NOT NULL REFERENCES agent_specs(composition_revision_id),
  rows                    INTEGER NOT NULL CHECK(rows >= 0),
  deriver_version         INTEGER NOT NULL,
  body_digest             TEXT NOT NULL,
  at                      TEXT NOT NULL
);
CREATE TRIGGER asset_usage_sessions_immutable BEFORE UPDATE ON asset_usage_sessions
BEGIN SELECT RAISE(ABORT, 'asset_usage_sessions rows are immutable'); END;
CREATE TRIGGER asset_usage_sessions_undeletable BEFORE DELETE ON asset_usage_sessions
BEGIN SELECT RAISE(ABORT, 'asset_usage_sessions rows are immutable'); END;
