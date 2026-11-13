-- P0-2 (docs/agentic-os-auto-copilot-plan.md §C.2) — autopilot core.
--
-- The plan names this migration 042; P0-A2 took that number for tasks.run_as, so the core is 043.
-- Acceptance runs (P0-4) and publications (P0-5) add their own tables in later migrations.

-- One row. `stopped` is the state every database starts in and the state a boot leaves it in:
-- only an `autopilot.operate` call makes it `running`.
CREATE TABLE autopilot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('stopped','draining','running')),
  -- Why it is not running: 'never-started', 'operator', 'drain', 'boot', 'github-auth', ...
  stop_reason TEXT,
  -- The operator secret's kid that last started it. Never the secret.
  started_by TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO autopilot_state(id, status, stop_reason, updated_at) VALUES (1, 'stopped', 'never-started', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- A window is a concrete night, not a schedule: an operator opens each one. The standing
-- nightly schedule is Stage 4 and will insert rows here.
CREATE TABLE autopilot_windows (
  id TEXT PRIMARY KEY,
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  max_items INTEGER NOT NULL CHECK (max_items >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (closes_at > opens_at),
  UNIQUE (opens_at)
);

-- §C.2.1. One row per attempt; a retry of an item is a new row, never a reset of this one.
CREATE TABLE autopilot_attempts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  reservation_id TEXT NOT NULL UNIQUE,
  reservation_sha TEXT,
  -- NULL only while `reserving` (the task is inserted with the move to `admitted`).
  task_id TEXT UNIQUE REFERENCES tasks(id),
  state TEXT NOT NULL CHECK (state IN (
    'reserving','admitted','running','suspended','settled','accepting','accepted','publishing','publish_uncertain',
    'published','closed','failed','blocked','cancelled','conflict','external')),
  -- Why a final or held attempt is where it is (a refusal reason, an approval denial, a stop).
  reason TEXT,
  runtime_budget_ms INTEGER NOT NULL CHECK (runtime_budget_ms > 0),
  -- The absolute deadline the last admitted launch ran under, and which bound set it.
  deadline_at TEXT,
  deadline_bound TEXT CHECK (deadline_bound IS NULL OR deadline_bound IN ('budget','window')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  final_at TEXT,
  UNIQUE (item_id, attempt_no),
  CHECK (task_id IS NOT NULL OR state IN ('reserving','external','cancelled','failed'))
);
-- Invariant 1: one non-final attempt at a time. `suspended` and `publish_uncertain` are non-final.
CREATE UNIQUE INDEX uq_autopilot_attempt_nonfinal ON autopilot_attempts((1))
  WHERE state IN ('reserving','admitted','running','suspended','settled','accepting','accepted','publishing','publish_uncertain');

-- Invariant: a final attempt never leaves its final state.
CREATE TRIGGER autopilot_attempt_final_is_final
BEFORE UPDATE OF state ON autopilot_attempts
WHEN OLD.state IN ('published','closed','failed','blocked','cancelled','conflict','external') AND NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'a final autopilot attempt cannot change state');
END;

-- §C.2.5. Inserted at the first admitted launch of an attempt in a window, so a carried attempt
-- pays in the window it runs in, once.
CREATE TABLE autopilot_window_charges (
  window_id TEXT NOT NULL REFERENCES autopilot_windows(id),
  attempt_id TEXT NOT NULL REFERENCES autopilot_attempts(id),
  charged_at TEXT NOT NULL,
  PRIMARY KEY (window_id, attempt_id)
);

-- Invariant 4. One row per provider session, written at settlement and backfilled at boot, so a
-- crash can neither count a session twice nor lose it.
CREATE TABLE autopilot_runtime (
  session_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES autopilot_attempts(id),
  ms INTEGER NOT NULL CHECK (ms >= 0),
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_autopilot_runtime_attempt ON autopilot_runtime(attempt_id);

-- Which attempt each launched session belongs to. Written in the transaction that admits the
-- launch (the final check), before a provider process exists.
CREATE TABLE autopilot_sessions (
  session_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES autopilot_attempts(id),
  window_id TEXT NOT NULL REFERENCES autopilot_windows(id),
  admitted_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL
);

-- §D.2 / D-13. The operator states that extra usage and auto-reload are off. Append-only; the
-- newest row is the current one, and it expires.
CREATE TABLE autopilot_billing_attestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  extra_usage_off INTEGER NOT NULL CHECK (extra_usage_off IN (0,1)),
  auto_reload_off INTEGER NOT NULL CHECK (auto_reload_off IN (0,1)),
  attested_by TEXT NOT NULL
);
