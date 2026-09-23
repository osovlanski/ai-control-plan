-- M16 K18 — decision_records: the shadow/applied audit trail for
-- `DecisionService.decide()` (plan `plans/jev-decision-service-plan.md` §5, K18).
--
-- THE INVARIANT THAT MATTERS MOST (packages/core/src/decision.ts, §4.4): a
-- record stores the question-set HASH and the ANSWERS. It never stores
-- `DecisionRequest.state` — state carries repository content and is exactly
-- what §4.4 exists to bound. No column here may ever hold it, in full,
-- truncated or summarized.
--
-- Append-only, per the DB-is-truth rule: no UPDATE, no DELETE, no upsert
-- touches this table. `task_id` / `session_id` are nullable because a decision
-- site is not required to be task-scoped (K20's task-classifier answers before
-- a task exists); K18 only ever populates both, since its one wired site
-- (tool-gate) always runs inside a session.
CREATE TABLE decision_records (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT REFERENCES tasks(id),
  session_id        TEXT REFERENCES runs(id),
  site              TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model_reported    TEXT,
  question_set_hash TEXT NOT NULL,
  answers_json      TEXT NOT NULL,
  latency_ms        INTEGER NOT NULL,
  input_tokens      INTEGER,
  mode              TEXT NOT NULL CHECK(mode IN ('shadow','applied')),
  degraded_reason   TEXT,
  state_truncated   INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_decision_records_task ON decision_records(task_id);
-- The K22 shadow report and GET /api/decisions both read "recent records for
-- a site" — this is that query's index, not a general-purpose one.
CREATE INDEX idx_decision_records_site_created ON decision_records(site, created_at);
