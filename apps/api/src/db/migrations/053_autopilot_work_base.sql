-- A retried attempt reuses its item's `os/<id>` ref while that ref holds only the reservation, so the
-- reservation commit can be many days behind main (G15 attempt 11 ran a tree from six days earlier).
-- The reservation commit stays what the publication's lease and lineage check name; the task's
-- worktree starts at this merge of current main into it when the two differ.
ALTER TABLE autopilot_attempts ADD COLUMN work_base_sha TEXT;
