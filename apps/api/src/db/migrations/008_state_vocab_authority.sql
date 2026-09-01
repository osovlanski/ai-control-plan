-- Phase 8e — runs.state vocabulary authority (execution-harness.md §5, deferral #2).
--
-- No dual-write. `runs.state` stays authoritative for legacy rows
-- (execution_request_id IS NULL); `runs.session_state` stays authoritative for
-- harness rows. Internal consumers derive the effective state at read time
-- (telemetry.scores, Orchestrator.comparison), so this migration is NOT
-- load-bearing — it is a one-time cosmetic/observability backfill that brings any
-- drifted legacy session_state back in line with the frozen authoritative
-- runs.state.
--
-- Restricted to the five known legacy state values. An unknown state is left
-- as-is so it surfaces rather than being masked. No UNIQUE(task_id, attempt)
-- index — that would block the future parallel/compare cutover (N requests per
-- logical attempt).
UPDATE runs SET session_state = CASE state
  WHEN 'STARTING'    THEN 'STARTING'
  WHEN 'ACTIVE'      THEN 'RUNNING'
  WHEN 'ENDED_OK'    THEN 'COMPLETED'
  WHEN 'ENDED_ERROR' THEN 'FAILED'
  WHEN 'CANCELLED'   THEN 'CANCELLED'
END
WHERE execution_request_id IS NULL
  AND state IN ('STARTING', 'ACTIVE', 'ENDED_OK', 'ENDED_ERROR', 'CANCELLED');
