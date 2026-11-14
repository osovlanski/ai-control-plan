-- P0-6 (docs/agentic-os-auto-copilot-plan.md §C.2.2, §C.3) — what an attempt reserved, and from what.
--
-- The intent row of §C.2.1 is the attempt itself (`reserving`, with reservation_id and
-- reservation_sha). These columns make it recoverable after a crash without re-reading the
-- backlog: which repository, which base commit, the commit message fixed for the reservation
-- commit (so a retry rebuilds the same content), the item's revision digest and the backlog
-- commit it was read at. All NULL on attempts made before P0-6 (in-process `reserve` only).

ALTER TABLE autopilot_attempts ADD COLUMN repo TEXT;              -- backlog repo name (autopilot.repos key)
ALTER TABLE autopilot_attempts ADD COLUMN base_sha TEXT;          -- parent of the reservation commit
ALTER TABLE autopilot_attempts ADD COLUMN reservation_date TEXT;  -- author/committer date of the reservation commit
ALTER TABLE autopilot_attempts ADD COLUMN item_revision TEXT;     -- sha256 over the item's canonical JSON (backlog-check --digests)
ALTER TABLE autopilot_attempts ADD COLUMN backlog_sha TEXT;       -- origin/main commit the item was read at
-- How the reservation ended: 'created' (201), 'owned' (422 whose root reservation is ours),
-- 'reused' (a retry on the ref of an earlier attempt of the same item). NULL while reserving.
ALTER TABLE autopilot_attempts ADD COLUMN reservation_outcome TEXT
  CHECK (reservation_outcome IS NULL OR reservation_outcome IN ('created','owned','reused'));
