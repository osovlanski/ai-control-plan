-- P0-7c (docs/agentic-os-auto-copilot-plan.md §C.5 "Restore fails closed").
--
-- An external record (an `os/*` reservation or an `aos-publication` PR this database did not
-- know, recorded by a restore reconciliation) blocks its item for ever until itay decides.
-- These columns record that decision. A dismissed row stays as history and no longer blocks the
-- item; the dispatcher still reads the `os/<id>` ref on GitHub before selecting an item, so a
-- dismissal never lets a run take a ref that still exists. A later restore that finds the
-- same record again reopens it (a restore is a new decision point).
ALTER TABLE autopilot_externals ADD COLUMN resolved_at TEXT;
ALTER TABLE autopilot_externals ADD COLUMN resolved_by TEXT;
ALTER TABLE autopilot_externals ADD COLUMN resolution TEXT CHECK (resolution IS NULL OR resolution IN ('dismissed'));
ALTER TABLE autopilot_externals ADD COLUMN resolution_note TEXT;
