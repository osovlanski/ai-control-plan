-- qcq-02 — the advisory estimate shown when a run started, kept beside that run.
--
-- One row per run, written once, right after the run row exists. Record-only: no dispatch,
-- reservation, budget, schedule or approval path reads it, and a failure to write it never stops a
-- start. The actual outcome is not copied here: it is read from the run's own records (ended_at,
-- settled usage) when the accuracy read joins the two, so there is one source for each fact.
--
-- Append-only: the stored estimate is what was shown, so it is never rewritten or removed.

CREATE TABLE run_estimates (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  assistant_id TEXT NOT NULL,
  estimator_version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  estimate_json TEXT NOT NULL,        -- RunEstimate, as served by GET /api/tasks/:id/estimate
  recommendation_json TEXT NOT NULL   -- ScheduleRecommendation at the same instant
);
CREATE INDEX idx_run_estimates_task ON run_estimates(task_id, recorded_at);

CREATE TRIGGER run_estimates_no_update BEFORE UPDATE ON run_estimates
BEGIN SELECT RAISE(ABORT, 'run_estimates is append-only'); END;
CREATE TRIGGER run_estimates_no_delete BEFORE DELETE ON run_estimates
BEGIN SELECT RAISE(ABORT, 'run_estimates is append-only'); END;
