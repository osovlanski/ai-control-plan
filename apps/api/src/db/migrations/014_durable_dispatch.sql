-- K1: user intent and scheduler ownership, separate from execution sessions.
ALTER TABLE tasks ADD COLUMN intent_json TEXT;
ALTER TABLE tasks ADD COLUMN pause_kind TEXT;
UPDATE tasks SET intent_json = json_object('goal', goal, 'constraints', json_extract(envelope, '$.constraints'),
 'repository', json_extract(envelope, '$.repository'), 'profile', profile);
-- Historical reasons cannot safely be inferred from free-text notices.
UPDATE tasks SET pause_kind = 'unknown' WHERE state = 'WAITING_INPUT';
CREATE TABLE wait_conditions (
 task_id TEXT NOT NULL REFERENCES tasks(id),
 generation INTEGER NOT NULL CHECK(generation > 0),
 state TEXT NOT NULL CHECK(state IN ('active','consumed','replaced','cancelled','expired')),
 kind TEXT NOT NULL CHECK(kind = 'time'),
 not_before TEXT NOT NULL,
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 auto_wakes INTEGER NOT NULL DEFAULT 0,
 history TEXT NOT NULL DEFAULT '[]',
 consumed_at TEXT,
 consumed_by TEXT,
 reason TEXT NOT NULL,
 PRIMARY KEY(task_id, generation)
);
CREATE UNIQUE INDEX uq_wait_active ON wait_conditions(task_id) WHERE state = 'active';
CREATE INDEX idx_wait_due ON wait_conditions(not_before) WHERE state = 'active';
CREATE TABLE dispatches (
 dispatch_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 condition_generation INTEGER NOT NULL,
 origin TEXT NOT NULL,
 checkpoint_id TEXT REFERENCES checkpoints(id),
 execution_path TEXT NOT NULL CHECK(execution_path IN ('legacy','harness')),
 phase TEXT NOT NULL CHECK(phase IN ('reserved','start_attempted','started','reparked','aborted','cancelled')),
 routing_decision_id INTEGER REFERENCES routing_decisions(id),
 session_id TEXT REFERENCES runs(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 reason TEXT,
 UNIQUE(task_id, condition_generation),
 FOREIGN KEY(task_id, condition_generation) REFERENCES wait_conditions(task_id, generation)
);
CREATE UNIQUE INDEX uq_dispatch_open ON dispatches(task_id) WHERE phase IN ('reserved','start_attempted');
ALTER TABLE runs ADD COLUMN dispatch_id TEXT REFERENCES dispatches(dispatch_id);
CREATE UNIQUE INDEX uq_run_dispatch ON runs(dispatch_id) WHERE dispatch_id IS NOT NULL;
-- Scheduler events precede runs, so they must not fabricate a provider run id.
CREATE TABLE scheduler_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 generation INTEGER,
 dispatch_id TEXT REFERENCES dispatches(dispatch_id),
 type TEXT NOT NULL,
 at TEXT NOT NULL,
 payload TEXT NOT NULL
);
CREATE INDEX idx_scheduler_events_task ON scheduler_events(task_id, id);
