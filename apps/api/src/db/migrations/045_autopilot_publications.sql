-- P0-5 (docs/agentic-os-auto-copilot-plan.md §C.2.4) — publications.
--
-- The plan names this migration 043; P0-2 took 043 and P0-4 (acceptance runs) takes 044.
--
-- Identity is repo + head + base + verified_sha + id. The PR body carries `aos-publication: <id>`,
-- and a PR is adopted only when all five match. Nothing here is a lease: the remote ref and the
-- marker are the truth, and this table records what the plane intended and what it issued.

CREATE TABLE autopilot_publications (
  -- The publication id, which is also the marker value.
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES autopilot_attempts(id),
  repo TEXT NOT NULL,              -- owner/name
  base TEXT NOT NULL,              -- base branch
  head TEXT NOT NULL,              -- os/<item>
  repo_path TEXT NOT NULL,         -- local repository holding verified_sha
  remote TEXT NOT NULL,            -- git remote the push goes to
  reservation_sha TEXT NOT NULL,   -- the lease value: where os/<item> must be before the push
  verified_sha TEXT NOT NULL,      -- the checkpoint acceptance passed on
  title TEXT NOT NULL,
  body TEXT NOT NULL,              -- carries the marker line
  state TEXT NOT NULL CHECK (state IN ('publishing','publish_uncertain','published','closed','conflict','failed','abandoned')),
  reason TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  -- §C.2.4: an uncertain create waits for itay. `retry` or `abandon`, never automatic.
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('retry','abandon')),
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  final_at TEXT,
  CHECK (state <> 'published' OR pr_number IS NOT NULL)
);

-- A final publication never moves again.
CREATE TRIGGER autopilot_publication_final_is_final
BEFORE UPDATE OF state ON autopilot_publications
WHEN OLD.state IN ('published','closed','conflict','failed','abandoned') AND NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'a final autopilot publication cannot change state');
END;

-- Every remote mutation, written BEFORE the request leaves and settled after. An outcome that is
-- NULL (the plane died mid-request) or 'unknown' (the response was lost) is an issued effect
-- nobody has resolved: §C.2.9 lists it, and a create in that state is never repeated on its own.
CREATE TABLE autopilot_publication_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL REFERENCES autopilot_publications(id),
  kind TEXT NOT NULL CHECK (kind IN ('push','create_pr')),
  issued_at TEXT NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ok','rejected','unknown')),
  detail TEXT,
  settled_at TEXT,
  -- Set when itay resolves the publication; the effect is then accounted for.
  resolved_at TEXT
);
CREATE INDEX idx_autopilot_publication_mutations ON autopilot_publication_mutations(publication_id);

-- A PR carrying our marker that is not the adopted one (a delayed create that landed after a
-- resolution, or a second create). Reported to itay, never deleted.
CREATE TABLE autopilot_publication_duplicates (
  publication_id TEXT NOT NULL REFERENCES autopilot_publications(id),
  pr_number INTEGER NOT NULL,
  pr_url TEXT,
  pr_state TEXT NOT NULL,
  found_at TEXT NOT NULL,
  PRIMARY KEY (publication_id, pr_number)
);
