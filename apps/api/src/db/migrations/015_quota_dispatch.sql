-- Preserve the referenced table name while widening the wait kind CHECK.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE wait_conditions_k2 (
 task_id TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL CHECK(generation > 0),
 state TEXT NOT NULL CHECK(state IN ('active','consumed','replaced','cancelled','expired')),
 kind TEXT NOT NULL CHECK(kind IN ('time','quota')), not_before TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, auto_wakes INTEGER NOT NULL DEFAULT 0,
 history TEXT NOT NULL DEFAULT '[]', consumed_at TEXT, consumed_by TEXT, reason TEXT NOT NULL,
 checkpoint_id TEXT REFERENCES checkpoints(id), blockers TEXT NOT NULL DEFAULT '[]',
 assistants TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(task_id,generation)
);
INSERT INTO wait_conditions_k2(task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,consumed_at,consumed_by,reason)
 SELECT task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,consumed_at,consumed_by,reason FROM wait_conditions;
DROP TABLE wait_conditions;
ALTER TABLE wait_conditions_k2 RENAME TO wait_conditions;
CREATE UNIQUE INDEX uq_wait_active ON wait_conditions(task_id) WHERE state = 'active';
CREATE INDEX idx_wait_due ON wait_conditions(not_before) WHERE state = 'active';
-- Scheduler replay stores resolved inputs without rendered prompt or secretEnv.
ALTER TABLE execution_requests ADD COLUMN request_json TEXT;
ALTER TABLE quota_snapshots ADD COLUMN account TEXT;
ALTER TABLE cooldowns ADD COLUMN kind TEXT NOT NULL DEFAULT 'unknown-recovery';
ALTER TABLE cooldowns ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE cooldowns ADD COLUMN reset_provenance TEXT NOT NULL DEFAULT 'fallback';
ALTER TABLE cooldowns ADD COLUMN account TEXT;
ALTER TABLE cooldowns ADD COLUMN bucket TEXT;
-- Rebuilding a referenced table leaves SQLite's deferred-drop counter set even
-- after the referenced name/keys exist again. Check the final graph explicitly
-- before clearing that temporary counter; foreign_keys stays enabled throughout.
CREATE TEMP TABLE k2_migration_fk_check (violations INTEGER NOT NULL CHECK(violations = 0));
INSERT INTO k2_migration_fk_check SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE k2_migration_fk_check;
PRAGMA defer_foreign_keys = OFF;
