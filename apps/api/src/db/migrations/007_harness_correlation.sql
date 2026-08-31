-- Execution Harness — Phase 6: correlation join keys for the §11 drill-down.
--
-- `ExecutionRequest.correlation` (§2) is opaque to the Harness — carried for
-- observability joins, never read by logic, explicitly excluded from the
-- request fingerprint. Persist it as two nullable columns so Cockpit can
-- navigate parent task / subtask group without a fingerprint change. Additive.

ALTER TABLE execution_requests ADD COLUMN parent_task_id TEXT;
ALTER TABLE execution_requests ADD COLUMN group_id       TEXT;

CREATE INDEX idx_execution_requests_group  ON execution_requests(group_id)       WHERE group_id       IS NOT NULL;
CREATE INDEX idx_execution_requests_parent ON execution_requests(parent_task_id) WHERE parent_task_id IS NOT NULL;
