-- K13 model selection: the missing cohort dimension.
--
-- §4.4.3 defines a telemetry cohort as "the same resolved model, the same task
-- kind, the same harness major version, inside the 30-day window". Nothing
-- recorded the harness major version until now, so it is added here and written
-- forward only.
--
-- DELIBERATELY NOT BACKFILLED. We cannot prove which execution-harness major
-- served a historical run, and inventing one would be exactly the alias-style
-- fabrication I-M5 forbids. Rows with a NULL `harness_major` never join a
-- cohort — the same rule `model_resolved = unknown` already obeys. The
-- consequence is honest and intended: K13 cohorts start empty, which is why the
-- activation gate cannot pass at merge time.
ALTER TABLE runs ADD COLUMN harness_major TEXT;

-- The cohort query filters on (model_resolved, harness_major, started_at).
CREATE INDEX IF NOT EXISTS idx_runs_model_cohort
  ON runs(model_resolved, harness_major, started_at);
