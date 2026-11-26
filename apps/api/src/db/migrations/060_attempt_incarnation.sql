-- #268 review (qcq-04b part 1): what an attempt's exit proof needs to know about the plane that
-- entered it and the manager its unit lives under.
-- 1. The entering plane incarnation, durable: another connection or a restarted plane can tell a
--    live incarnation (same boot, its process still running) from a dead one. NULL = migrated or
--    entered before this migration, read as a dead incarnation, as before.
ALTER TABLE execution_attempts ADD COLUMN entered_incarnation TEXT;
CREATE TABLE plane_incarnations (
  incarnation_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  -- /proc/<pid>/stat field 22 (start time in clock ticks since boot): a reused pid has another.
  proc_start TEXT,
  boot_id TEXT NOT NULL,
  started_at TEXT NOT NULL
);
-- 2. The manager the unit was assigned under, recorded at entry: { uid, user?, wrapper? }. Recovery
--    reads and stops the unit there, not under whatever the agent user is configured as later.
ALTER TABLE execution_attempts ADD COLUMN provider_unit_owner TEXT;
