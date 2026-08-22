-- Phase 5: parallel execution and telemetry-fed routing.

-- How a task executes. 'single' is the Phase 1-4 behaviour and stays the default.
ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'single';

-- Parallel runs each get their own worktree and branch, so two assistants never
-- share a working tree (arch §11).
ALTER TABLE runs ADD COLUMN worktree_path TEXT;
ALTER TABLE runs ADD COLUMN branch TEXT;
-- Set when a comparison is resolved: 'winner' | 'rejected'.
ALTER TABLE runs ADD COLUMN outcome TEXT;

-- Records how a comparison was decided, so the choice is auditable alongside
-- routing decisions and handoffs.
CREATE TABLE comparisons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  winner_run_id TEXT REFERENCES runs(id),
  decided_by    TEXT NOT NULL,   -- user | race
  reason        TEXT,
  merged_ref    TEXT,
  at            TEXT NOT NULL
);
CREATE INDEX idx_comparisons_task ON comparisons(task_id);
