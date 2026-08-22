-- Phase 2: checkpoints, handoff, and quota failover support.

-- The worktree a task's runs execute in. Persisted so a failover run reuses the
-- same tree (and survives a restart) instead of branching again.
ALTER TABLE tasks ADD COLUMN worktree_path TEXT;
ALTER TABLE tasks ADD COLUMN base_ref TEXT;

-- Concise activity summary carried inline in the handoff package.
ALTER TABLE checkpoints ADD COLUMN activity_summary TEXT;

-- Routing penalty for an assistant that hit a limit or failed. `until` is the
-- provider's own resets_at when it reported one, else a decaying window.
CREATE TABLE cooldowns (
  assistant_id TEXT PRIMARY KEY REFERENCES assistants(id),
  reason       TEXT NOT NULL,
  until        TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
