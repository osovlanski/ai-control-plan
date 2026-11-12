-- P0-A2 (docs/agentic-os-auto-copilot-plan.md §C.0) — which Unix user a task's code runs as.
--
-- tasks.run_as: 'agent' when the task's provider, and anything that came from its repository,
-- must run as the agent Unix user and never as the plane user. Written once at creation and
-- never changed: a task cannot move across the boundary after it has a worktree. NULL = the
-- plane user, as every task before 042.
ALTER TABLE tasks ADD COLUMN run_as TEXT CHECK (run_as IS NULL OR run_as = 'agent');
