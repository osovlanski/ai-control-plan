-- P0-7b (docs/agentic-os-auto-copilot-plan.md §C.5 "Restore fails closed").
--
-- One row per restore the plane detected at boot. The restore script writes a `restored_at.json`
-- marker next to the database BEFORE it swaps the file; the plane records the marker here in the
-- same transaction that stops the autopilot, then moves the marker aside. `marker_digest` is
-- unique, so a crash between the insert and the move records the restore once.
--
-- While a row has `cleared_at IS NULL`, `POST /api/autopilot/start` is refused until the
-- reconciliation report exists, is complete, and has been read back through `autopilot.operate`
-- (`read_digest = report_digest`). A successful start clears it. Every window that was open
-- when a restore was detected admits no launch, cleared or not (see `detected_at`).
CREATE TABLE autopilot_restores (
  id TEXT PRIMARY KEY,
  marker_digest TEXT NOT NULL UNIQUE,
  restored_at TEXT NOT NULL,
  -- The backup's file name (never a path or a URL), when the marker names one.
  backup_name TEXT,
  backup_taken_at TEXT,
  backup_sha256 TEXT,
  detected_at TEXT NOT NULL,
  report_json TEXT,
  report_digest TEXT,
  -- 1 when every section could be read; an incomplete report never unlocks a start.
  report_complete INTEGER CHECK (report_complete IS NULL OR report_complete IN (0,1)),
  reconciled_at TEXT,
  reconcile_error TEXT,
  read_at TEXT,
  read_by TEXT,
  read_digest TEXT,
  cleared_at TEXT,
  cleared_by TEXT
);
CREATE INDEX ix_autopilot_restores_detected ON autopilot_restores(detected_at);

-- §C.5: an `os/*` reservation or an `aos-publication` PR that this database does not know.
-- Recorded by the restore reconciliation and never re-run: the dispatcher reports an item with
-- an external reservation as blocked.
CREATE TABLE autopilot_externals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('reservation','publication')),
  repo TEXT NOT NULL,
  head TEXT NOT NULL,
  item_id TEXT,
  sha TEXT,
  reservation_id TEXT,
  pr_number INTEGER,
  marker TEXT,
  detail TEXT NOT NULL,
  restore_id TEXT REFERENCES autopilot_restores(id),
  recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_autopilot_externals ON autopilot_externals(kind, repo, head, COALESCE(reservation_id, ''), COALESCE(pr_number, 0));
CREATE INDEX ix_autopilot_externals_item ON autopilot_externals(item_id);
