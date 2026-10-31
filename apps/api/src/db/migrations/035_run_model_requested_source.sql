-- Which rule chose runs.model_requested (plan §3.1, the revision binds the run):
--   task-override  the task's intent.overrides.model
--   k13-applied    a selector K13 committed in applied mode for this dispatch
--   revision       the bound composition revision's model.primary
-- NULL when nothing pinned the model (the CLI default) and on every run before
-- 035: the rule that chose a historical selector was never recorded.
ALTER TABLE runs ADD COLUMN model_requested_source TEXT;
