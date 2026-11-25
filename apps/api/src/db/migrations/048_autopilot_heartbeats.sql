-- P0-7a (docs/agentic-os-auto-copilot-plan.md §C.5, D-14): the external heartbeat's ledger.
-- One row per ping the plane tried while the autopilot was live, plus a `paused` row the first
-- time it is found stopped after a ping. The ping URL is a secret and is never stored here.
CREATE TABLE autopilot_heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ping','paused')),
  -- 1 for a 2xx answer, 0 otherwise; NULL on a `paused` row.
  ok INTEGER CHECK (ok IS NULL OR ok IN (0,1)),
  http_status INTEGER,
  -- An error class or an HTTP status, never a message that could carry the URL.
  error TEXT,
  CHECK ((kind = 'ping') = (ok IS NOT NULL))
);
CREATE INDEX ix_autopilot_heartbeats_at ON autopilot_heartbeats(at);
