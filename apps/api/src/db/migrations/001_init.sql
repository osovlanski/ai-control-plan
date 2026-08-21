-- Domain model v1 (docs/revised-architecture.md §3).
-- Conventions: TEXT ISO-8601 timestamps; JSON in TEXT columns; append-only events.

CREATE TABLE assistants (
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,           -- anthropic | openai | cursor | bedrock
  tier                INTEGER NOT NULL DEFAULT 1,
  enabled             INTEGER NOT NULL DEFAULT 1,
  manifest            TEXT,                    -- JSON CapabilityManifest
  manifest_updated_at TEXT
);

CREATE TABLE capability_changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  assistant_id TEXT NOT NULL REFERENCES assistants(id),
  field        TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  source       TEXT NOT NULL,                  -- runtime-probe | provider-api | local-config | manual
  observed_at  TEXT NOT NULL
);
CREATE INDEX idx_capability_changes_assistant ON capability_changes(assistant_id, observed_at);

CREATE TABLE quota_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  assistant_id TEXT NOT NULL REFERENCES assistants(id),
  window       TEXT NOT NULL,                  -- e.g. 5h | weekly | monthly-credit
  used_percent REAL,
  resets_at    TEXT,
  source       TEXT NOT NULL,
  observed_at  TEXT NOT NULL
);
CREATE INDEX idx_quota_snapshots_assistant ON quota_snapshots(assistant_id, observed_at);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  goal           TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'CREATED',
  activity_phase TEXT,                         -- informational only, never drives orchestration
  profile        TEXT NOT NULL DEFAULT 'auto',
  repo_path      TEXT,
  branch         TEXT,
  envelope       TEXT NOT NULL,                -- JSON TaskEnvelope (materialized current state)
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_tasks_state ON tasks(state);

CREATE TABLE task_decisions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  text    TEXT NOT NULL,
  made_by TEXT NOT NULL,                       -- user | agent:<assistant_id>
  at      TEXT NOT NULL
);
CREATE INDEX idx_task_decisions_task ON task_decisions(task_id);

CREATE TABLE routing_decisions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  chosen_assistant_id TEXT REFERENCES assistants(id),   -- NULL when no candidate passed filters
  explanation         TEXT NOT NULL,           -- JSON RoutingExplanation
  at                  TEXT NOT NULL
);
CREATE INDEX idx_routing_decisions_task ON routing_decisions(task_id);

CREATE TABLE runs (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES tasks(id),
  assistant_id         TEXT NOT NULL REFERENCES assistants(id),
  provider_session_ref TEXT,                   -- provider session/thread id for resume()
  state                TEXT NOT NULL,          -- STARTING | ACTIVE | ENDED_OK | ENDED_ERROR | CANCELLED
  usage                TEXT,                   -- JSON rollup (tokens, quota trajectory)
  started_at           TEXT NOT NULL,
  ended_at             TEXT
);
CREATE INDEX idx_runs_task ON runs(task_id);

CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL REFERENCES runs(id),
  seq     INTEGER NOT NULL,                    -- monotonic per run, assigned at ingestion
  ts      TEXT NOT NULL,
  type    TEXT NOT NULL,                       -- closed NormalizedEventType set
  phase   TEXT,
  summary TEXT,
  payload TEXT,                                -- JSON normalized detail
  raw     TEXT,                                -- JSON original provider payload
  UNIQUE (run_id, seq)
);
CREATE INDEX idx_events_run ON events(run_id, seq);

CREATE TABLE checkpoints (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  run_id            TEXT REFERENCES runs(id),
  envelope_snapshot TEXT NOT NULL,             -- JSON TaskEnvelope at checkpoint time
  git_ref           TEXT,                      -- checkpoint commit on the task branch
  diff_stat         TEXT,
  reason            TEXT NOT NULL,             -- limit | handoff | cancel | completion | periodic
  at                TEXT NOT NULL
);
CREATE INDEX idx_checkpoints_task ON checkpoints(task_id);

CREATE TABLE handoffs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  from_run_id   TEXT REFERENCES runs(id),
  to_run_id     TEXT REFERENCES runs(id),
  checkpoint_id TEXT REFERENCES checkpoints(id),
  trigger       TEXT NOT NULL,                 -- manual | quota | failure
  at            TEXT NOT NULL
);
CREATE INDEX idx_handoffs_task ON handoffs(task_id);
