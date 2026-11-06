-- K13 A2 — the provider CLI version that served a run (docs/agentic-os-k13-alias-identity.md §5).
--
-- runs.harness_cli_version: the `version` the provider reported in its own `run.started` event
-- (Claude: `system/init` claude_code_version). It is evidence of what ran, written once by the
-- session runner from that event and never inferred or copied from a probe. NULL when the
-- provider reported none (Codex/Cursor today, a failure before init) and on every run before 041:
-- forward only, not backfilled, because a historical run's CLI version was never recorded.
ALTER TABLE runs ADD COLUMN harness_cli_version TEXT;
