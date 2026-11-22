-- mcp-api-grants (API 2.14, docs/adr/mcp-connector.md "Idempotency").
--
-- One row per (credential kid, operation, client key). `fingerprint` is sha256 of the canonical JSON
-- of the normalized request without the key: the same key with another fingerprint is a 409
-- conflict and has no effect. The row is written in the same transaction as the effect (the task
-- row for a create, the CREATED -> ROUTING transition for a start), so a key can never be recorded
-- without its effect or the other way round. `response_json` is filled when the request finishes;
-- NULL means the process stopped between the effect and the answer, and a replay rebuilds the
-- answer from the task. Rows are kept at least 7 days.

CREATE TABLE idempotency_records (
  credential_kid TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('task.create','task.start')),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  status_code INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (credential_kid, operation, idempotency_key)
);
CREATE INDEX idx_idempotency_records_created ON idempotency_records(created_at);
