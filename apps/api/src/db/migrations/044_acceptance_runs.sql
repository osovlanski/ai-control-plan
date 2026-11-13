-- P0-4 (docs/agentic-os-auto-copilot-plan.md §C.2.7) — acceptance runs.
--
-- The plan names this migration 042; P0-A2 took 042 and P0-2 took 043, so acceptance is 044
-- (publications, P0-5, follow it).
--
-- One row per run of an attempt's trusted acceptance commands on a fresh detached snapshot of
-- the checkpoint SHA. A retry after a crash is a NEW row (`run_no` + 1) on a NEW snapshot, never
-- a reuse of this one.
CREATE TABLE acceptance_runs (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES autopilot_attempts(id),
  run_no INTEGER NOT NULL CHECK (run_no >= 1),
  -- The checkpoint SHA the commands ran on. NULL only for a run blocked before a SHA existed.
  sha TEXT,
  -- Where the commands came from: the backlog at this ref, resolved to this commit. Never the worktree.
  source_ref TEXT NOT NULL,
  source_sha TEXT,
  snapshot_path TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('preparing','running','passed','failed','blocked','cut','crashed')),
  -- Why a run that did not pass is where it is.
  reason TEXT,
  -- [{ run, replaySafe, timeoutSec?, status, exitCode?, signal?, startedAt?, endedAt?, outputTail? }]
  commands_json TEXT NOT NULL DEFAULT '[]',
  writable_json TEXT NOT NULL DEFAULT '[]',
  -- Fingerprints of the tracked tree (paths, modes, contents, inode change times) before and after.
  tree_before TEXT,
  tree_after TEXT,
  -- Up to 20 tracked paths whose fingerprint changed, when the hashes differ.
  tree_diff_json TEXT,
  -- Effects the plane cannot know after a crash of a command that is not replay-safe (§C.2.7 step 7).
  unknown_effects_json TEXT,
  deadline_at TEXT,
  deadline_bound TEXT CHECK (deadline_bound IS NULL OR deadline_bound IN ('budget','window')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (attempt_id, run_no)
);
-- One live run at a time across the plane (the autopilot runs one attempt at a time anyway).
CREATE UNIQUE INDEX uq_acceptance_run_live ON acceptance_runs((1)) WHERE state IN ('preparing','running');
CREATE INDEX idx_acceptance_runs_attempt ON acceptance_runs(attempt_id);

-- A finished run never changes its verdict.
CREATE TRIGGER acceptance_run_final_is_final
BEFORE UPDATE OF state ON acceptance_runs
WHEN OLD.state IN ('passed','failed','blocked','cut','crashed') AND NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'a finished acceptance run cannot change state');
END;
