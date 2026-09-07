-- K5: recurring schedules. Intent only (I-S1) — the assistant, model and
-- composition are still recomputed by routeTask at every dispatch.
CREATE TABLE schedules (
  schedule_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK(kind IN ('user','system')),
  intent_json TEXT NOT NULL,
  cron        TEXT NOT NULL,             -- 5 fields
  timezone    TEXT NOT NULL,             -- IANA
  enabled     INTEGER NOT NULL DEFAULT 1,
  overlap     TEXT NOT NULL DEFAULT 'skip' CHECK(overlap = 'skip'),  -- 'queue' deferred
  catch_up_window_minutes INTEGER NOT NULL DEFAULT 1440 CHECK(catch_up_window_minutes >= 0),
  last_fired_at TEXT,
  next_fire_at  TEXT,
  -- Display only. schedule_occurrences is the deduplication mechanism.
  last_task_id  TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_schedules_due ON schedules(next_fire_at) WHERE enabled = 1;

-- One row per scheduled occurrence. The primary key IS the dedup constraint:
-- a duplicate tick for the same instant violates it and creates nothing.
CREATE TABLE schedule_occurrences (
  schedule_id   TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE CASCADE,
  occurrence_at TEXT NOT NULL,           -- the cron instant, in UTC
  fired_at      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK(outcome IN ('created','skipped-overlap','skipped-catch-up','skipped-disabled')),
  task_id       TEXT REFERENCES tasks(id),
  PRIMARY KEY(schedule_id, occurrence_at)
);

-- Whether the scheduler was enabled when it last observed itself. Occurrences
-- missed while it was off are recorded 'skipped-disabled' on the next enable,
-- which a restart alone cannot distinguish from an ordinary catch-up.
CREATE TABLE scheduler_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL,
  observed_at TEXT NOT NULL
);
