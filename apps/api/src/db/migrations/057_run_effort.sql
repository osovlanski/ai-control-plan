-- P1-5 — effort in the execution identity.
--
-- runs.effort_reported: the reasoning effort the PROVIDER reported in its own `run.started` event,
-- normalized (trimmed, lower-case). Write-once, first report wins, like model_resolved and
-- harness_cli_version. NULL means the provider reported none: every run before 057, every legacy
-- orchestrator run, and every provider that does not report effort today. NULL is read as the
-- cohort value `unknown`, never as a default level and never inferred from the request, the
-- routing profile or a CLI default.
--
-- runs.effort_reported_source: where the value came from (`run.started`), NULL with it.
ALTER TABLE runs ADD COLUMN effort_reported TEXT;
ALTER TABLE runs ADD COLUMN effort_reported_source TEXT;
