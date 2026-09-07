-- K4: dependency waits. Widening the `kind` CHECK needs a table rebuild, so the
-- 015 pattern is repeated: rebuild under deferred foreign keys, verify the final
-- graph explicitly, then clear the deferral.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE wait_conditions_k4 (
 task_id TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL CHECK(generation > 0),
 state TEXT NOT NULL CHECK(state IN ('active','consumed','replaced','cancelled','expired')),
 kind TEXT NOT NULL CHECK(kind IN ('time','quota','dependency')), not_before TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, auto_wakes INTEGER NOT NULL DEFAULT 0,
 history TEXT NOT NULL DEFAULT '[]', consumed_at TEXT, consumed_by TEXT, reason TEXT NOT NULL,
 checkpoint_id TEXT REFERENCES checkpoints(id), blockers TEXT NOT NULL DEFAULT '[]',
 assistants TEXT NOT NULL DEFAULT '[]',
 -- kind='dependency': the task ids every wake must find terminal. Validated
 -- non-self and acyclic at attach; a missing row counts as FAILED at evaluation.
 depends_on TEXT NOT NULL DEFAULT '[]',
 on_dependency_failure TEXT CHECK(on_dependency_failure IN ('cancel','wake-anyway','wait-input')),
 PRIMARY KEY(task_id,generation)
);
INSERT INTO wait_conditions_k4(task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,consumed_at,consumed_by,reason,checkpoint_id,blockers,assistants)
 SELECT task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,consumed_at,consumed_by,reason,checkpoint_id,blockers,assistants FROM wait_conditions;
DROP TABLE wait_conditions;
ALTER TABLE wait_conditions_k4 RENAME TO wait_conditions;
CREATE UNIQUE INDEX uq_wait_active ON wait_conditions(task_id) WHERE state = 'active';
CREATE INDEX idx_wait_due ON wait_conditions(not_before) WHERE state = 'active';
-- Dependency wakes are event-driven; this index serves the timer's safety-net sweep.
CREATE INDEX idx_wait_dependency ON wait_conditions(kind) WHERE state = 'active' AND kind = 'dependency';
CREATE TEMP TABLE k4_migration_fk_check (violations INTEGER NOT NULL CHECK(violations = 0));
INSERT INTO k4_migration_fk_check SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE k4_migration_fk_check;
PRAGMA defer_foreign_keys = OFF;
