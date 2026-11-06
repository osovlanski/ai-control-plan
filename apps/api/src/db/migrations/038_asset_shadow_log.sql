-- M6 S4 — asset shadow log (docs/agentic-os-m6-composition-telemetry.md §4.2, Q9).
--
-- 038 was reserved for this file while 039 (O6 S5) landed first. The runner applies every file
-- whose name is not in schema_migrations, so a database that already has 039 gains 038 too.
--
-- One row per composition attempt that reached stage 3, previews included: stage 3's computed
-- choice, the shadow's choice with ties broken by asset-shadow/v1 lift, and the per-candidate
-- scores it read. Written after the attempt row and outside its transaction, best-effort. The
-- shadow never enters the decision, the spec, compositionDigest or inputs_digest. A scorer error
-- is a row with an error code (never a message, which could quote stored content), and the
-- compose it shadows is unaffected. Rows are append-only.
CREATE TABLE asset_shadow_log (
  attempt_id        TEXT PRIMARY KEY REFERENCES composition_attempts(id),
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  status            TEXT NOT NULL CHECK(status IN ('scored', 'error')),
  formula           TEXT NOT NULL,
  task_kind         TEXT,
  harness           TEXT,
  -- Stage 3's computed choice (before an operator add/remove), sorted ids, as JSON.
  actual_json       TEXT NOT NULL,
  shadow_json       TEXT,
  would_differ      INTEGER CHECK(would_differ IN (0, 1)),
  -- Shadow choices a hard filter removed: 0 by construction, audited.
  filter_violations INTEGER CHECK(filter_violations >= 0),
  overridden        INTEGER NOT NULL CHECK(overridden IN (0, 1)),
  scores_json       TEXT,
  error             TEXT,
  -- The end of the 30-day telemetry window the scores were read over.
  window_end        TEXT NOT NULL,
  at                TEXT NOT NULL,
  CHECK((status = 'error') = (error IS NOT NULL)),
  CHECK(status = 'error' OR (shadow_json IS NOT NULL AND would_differ IS NOT NULL AND filter_violations IS NOT NULL AND scores_json IS NOT NULL))
);
CREATE INDEX idx_asset_shadow_log_at ON asset_shadow_log(at);
CREATE INDEX idx_asset_shadow_log_task ON asset_shadow_log(task_id);
CREATE TRIGGER asset_shadow_log_immutable BEFORE UPDATE ON asset_shadow_log
BEGIN SELECT RAISE(ABORT, 'asset_shadow_log rows are immutable'); END;
CREATE TRIGGER asset_shadow_log_undeletable BEFORE DELETE ON asset_shadow_log
BEGIN SELECT RAISE(ABORT, 'asset_shadow_log rows are immutable'); END;
