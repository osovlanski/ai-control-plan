-- K11 bounded context continuation (kernel-services §4.3.3).
--
-- The dispatch origin a wait must produce when it wakes. Durable so a crash
-- between a settled YIELDED(context) and the successor dispatch cannot relabel
-- a context continuation as an ordinary wake (CR-30: origin is audit truth).
-- NULL keeps the pre-K11 mapping (operator -> run-now, otherwise wake).
ALTER TABLE wait_conditions ADD COLUMN origin TEXT;

-- Continuation number, no-progress detection and reliability aggregation are
-- all derived from rows that already exist (dispatches, checkpoints, handoffs,
-- execution_results). No continuation-history table is introduced.
CREATE INDEX idx_dispatch_origin ON dispatches(task_id, origin);
