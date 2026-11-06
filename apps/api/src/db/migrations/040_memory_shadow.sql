-- O6 S3 — memory bundle federation and shadow demotion (docs/agentic-os-o6-memory-writeback.md §2.2, Q3).
--
-- memory_bundle_snapshots: Cockpit's memory v1 snapshots that validated, one row per distinct
-- snapshot digest. The newest by last_seen_at is the last good snapshot; a failed sync changes no
-- row here. The body is digests, member file names and health counts: no memory content, no
-- directory, no hostname (memory v1 keeps those on Cockpit's side).
CREATE TABLE memory_bundle_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  -- Cockpit's observedAt: the time base of every age in the snapshot.
  observed_at     TEXT NOT NULL,
  snapshot_json   TEXT NOT NULL,
  bundle_count    INTEGER NOT NULL CHECK(bundle_count >= 0),
  -- The plane's clock: when this digest was first and last fetched and validated.
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  UNIQUE(source, snapshot_digest)
);
CREATE INDEX idx_memory_bundle_snapshots_seen ON memory_bundle_snapshots(source, last_seen_at);

CREATE TABLE memory_sync_state (
  source          TEXT PRIMARY KEY,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  -- A classified reason (registry federation's vocabulary), never a response body.
  last_failure    TEXT
);

-- memory_shadow_log: one row per pinned memory bundle per composition attempt that reached
-- stage 4, previews included. production_action is what stage 4 did (read from the decision);
-- shadow_action is what memory-shadow/v1 says it would do. Written after the attempt row and
-- outside its transaction, best-effort. The shadow never enters the decision, the spec,
-- compositionDigest or inputs_digest. A scorer error is one row for the attempt with bundle_id
-- NULL and an error code (never a message). Rows are append-only.
CREATE TABLE memory_shadow_log (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id             TEXT NOT NULL REFERENCES composition_attempts(id),
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  bundle_id              TEXT,
  status                 TEXT NOT NULL CHECK(status IN ('scored', 'error')),
  rule                   TEXT NOT NULL,
  pinned_digest          TEXT,
  snapshot_bundle_digest TEXT,
  -- The snapshot the rule read (NULL when the plane held none), and whether it was past
  -- registry.cockpit.maxCacheAgeHours when read.
  snapshot_digest        TEXT,
  snapshot_observed_at   TEXT,
  snapshot_stale         INTEGER CHECK(snapshot_stale IN (0, 1)),
  production_action      TEXT CHECK(production_action IN ('included', 'excluded_by_renderer', 'not_found', 'not_rendered')),
  production_reason      TEXT,
  shadow_action          TEXT CHECK(shadow_action IN ('keep', 'demote', 'unknown', 'drifted')),
  reason                 TEXT,
  members                INTEGER CHECK(members >= 0),
  stale_members          INTEGER CHECK(stale_members >= 0),
  oldest_age_days        INTEGER,
  duplicate_pairs        INTEGER CHECK(duplicate_pairs >= 0),
  ghosts                 INTEGER CHECK(ghosts >= 0),
  oversized              INTEGER CHECK(oversized >= 0),
  findings_digest        TEXT,
  error                  TEXT,
  at                     TEXT NOT NULL,
  UNIQUE(attempt_id, bundle_id),
  CHECK((status = 'error') = (error IS NOT NULL)),
  CHECK(status = 'error' OR (bundle_id IS NOT NULL AND pinned_digest IS NOT NULL AND production_action IS NOT NULL
    AND shadow_action IS NOT NULL AND reason IS NOT NULL AND snapshot_stale IS NOT NULL))
);
CREATE INDEX idx_memory_shadow_log_task ON memory_shadow_log(task_id);
CREATE INDEX idx_memory_shadow_log_at ON memory_shadow_log(at);
CREATE TRIGGER memory_shadow_log_immutable BEFORE UPDATE ON memory_shadow_log
BEGIN SELECT RAISE(ABORT, 'memory_shadow_log rows are immutable'); END;
CREATE TRIGGER memory_shadow_log_undeletable BEFORE DELETE ON memory_shadow_log
BEGIN SELECT RAISE(ABORT, 'memory_shadow_log rows are immutable'); END;
