-- K5 `overlap: queue` — the capability deferred out of §4.2.6.
--
-- The occurrence row IS the durable unit of queued work: no queue table, no
-- second identity. `(schedule_id, occurrence_at)` stays the primary key, so a
-- duplicate tick still cannot create a second queue entry any more than it
-- could create a second task.
--
-- Both tables are rebuilt rather than altered because the two values this slice
-- needs are forbidden by CHECK constraints, and SQLite cannot widen a CHECK in
-- place. The order below is load-bearing: `schedule_occurrences` is renamed
-- away FIRST, so that when `schedules` is finally dropped it has no children
-- and its ON DELETE CASCADE cannot take the occurrence history with it.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE schedule_occurrences RENAME TO schedule_occurrences_old;
ALTER TABLE schedules RENAME TO schedules_old;

CREATE TABLE schedules (
  schedule_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK(kind IN ('user','system')),
  intent_json TEXT NOT NULL,
  cron        TEXT NOT NULL,             -- 5 fields
  timezone    TEXT NOT NULL,             -- IANA
  enabled     INTEGER NOT NULL DEFAULT 1,
  -- 'queue': an occurrence that comes due while the previous one is still
  -- non-terminal is persisted as queued work instead of being dropped.
  overlap     TEXT NOT NULL DEFAULT 'skip' CHECK(overlap IN ('skip','queue')),
  catch_up_window_minutes INTEGER NOT NULL DEFAULT 1440 CHECK(catch_up_window_minutes >= 0),
  last_fired_at TEXT,
  next_fire_at  TEXT,
  -- Display only. schedule_occurrences is the deduplication mechanism AND the
  -- authority on whether a schedule currently has a non-terminal task.
  last_task_id  TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO schedules SELECT * FROM schedules_old;

CREATE TABLE schedule_occurrences (
  schedule_id   TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE CASCADE,
  occurrence_at TEXT NOT NULL,           -- the cron instant, in UTC
  fired_at      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK(outcome IN ('created','queued','skipped-overlap','skipped-catch-up','skipped-disabled')),
  task_id       TEXT REFERENCES tasks(id),
  -- Queue provenance. Never cleared, so `created` with a non-null queued_at
  -- stays distinguishable from `created` at the cron instant: claiming a task
  -- was made at 09:00 when it was made at 09:10 would be a false audit.
  queued_at     TEXT,
  promoted_at   TEXT,
  -- The TaskIntent this occurrence was enqueued with. A queued occurrence may
  -- run long after the schedule was edited and must still produce the task its
  -- own instant described. Intent only (I-S1) — never a resolved assistant,
  -- provider, model or routing decision, so nothing about execution is frozen.
  intent_json   TEXT,
  PRIMARY KEY(schedule_id, occurrence_at)
);
-- Existing rows keep NULL in all three: no historical queue state is invented.
INSERT INTO schedule_occurrences(schedule_id, occurrence_at, fired_at, outcome, task_id)
  SELECT schedule_id, occurrence_at, fired_at, outcome, task_id FROM schedule_occurrences_old;

DROP TABLE schedule_occurrences_old;
DROP TABLE schedules_old;

CREATE INDEX idx_schedules_due ON schedules(next_fire_at) WHERE enabled = 1;
-- The FIFO read: oldest queued occurrence per schedule.
CREATE INDEX idx_schedule_queue ON schedule_occurrences(schedule_id, occurrence_at) WHERE outcome = 'queued';
-- The terminal-task hook asks "is this task a schedule occurrence?" for EVERY
-- task that settles, and occurrence history grows one row per occurrence
-- forever. Without this that question is a full scan of it.
CREATE INDEX idx_schedule_occurrences_task ON schedule_occurrences(task_id) WHERE task_id IS NOT NULL;
