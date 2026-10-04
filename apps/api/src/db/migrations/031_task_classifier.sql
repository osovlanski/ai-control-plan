-- M16 K20 — the task label is stored at intake (plans/k20-task-classifier-proposal.md §3).
--
-- Until now the label was recomputed from the goal at read time for every
-- historical row, so any change to the classifier silently re-cohorted all
-- past telemetry. A new task now stores the label routing used, and the
-- version that produced it, once, at creation.
--
-- NULL on every pre-031 row, and it stays NULL: telemetry labels such a row
-- with the FROZEN `classifyTaskV1`, which is exactly the label it has always
-- had. Never backfill an old row, and never with a newer version — that is
-- the re-cohorting this migration exists to stop.
--
-- The CHECK is the label set. A new label invalidates every cohort, so it
-- should take a migration, not a one-line edit.
ALTER TABLE tasks ADD COLUMN task_kind TEXT
  CHECK(task_kind IS NULL OR task_kind IN ('coding','review','research','general'));
ALTER TABLE tasks ADD COLUMN classifier_version INTEGER;

-- The rule behind each answer on a `task-classifier` decision record, as a
-- JSON object keyed by answer key (e.g. {"kind_v2":"whole-word","high_stakes":"publish"}).
-- Additive on the append-only table; NULL on every other site and every
-- pre-031 row, since a backfilled rule would be a fabricated one.
ALTER TABLE decision_records ADD COLUMN rules_json TEXT;
