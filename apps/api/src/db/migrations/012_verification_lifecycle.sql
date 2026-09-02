-- Durable verification planning is additive: legacy requests/sessions have no
-- rows here and remain readable. Plan revisions are immutable facts; runs are
-- the operational claim/settlement records that may change state.
CREATE TABLE verification_plan_revisions (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES runs(id),
  execution_request_id  TEXT NOT NULL REFERENCES execution_requests(id),
  revision              INTEGER NOT NULL CHECK (revision > 0),
  supersedes_revision_id TEXT REFERENCES verification_plan_revisions(id),
  plan_fingerprint      TEXT NOT NULL,
  fingerprint_algorithm TEXT NOT NULL CHECK (fingerprint_algorithm = 'sha256-canonical-verification-plan-v1'),
  plan                  TEXT NOT NULL CHECK (json_valid(plan) AND json_type(plan) = 'object'),
  reason                TEXT NOT NULL CHECK (reason IN ('initial','post_change','recovery')),
  created_at            TEXT NOT NULL,
  UNIQUE (session_id, revision),
  UNIQUE (session_id, plan_fingerprint),
  CHECK (COALESCE(json_type(plan, '$.schemaVersion') = 'integer' AND json_extract(plan, '$.schemaVersion') = 1, 0)),
  CHECK (COALESCE(json_type(plan, '$.planRevisionId') = 'text' AND json_extract(plan, '$.planRevisionId') = id, 0)),
  CHECK (COALESCE(json_type(plan, '$.revision') = 'integer' AND json_extract(plan, '$.revision') = revision, 0)),
  CHECK (COALESCE(json_type(plan, '$.planFingerprint') = 'text' AND json_extract(plan, '$.planFingerprint') = plan_fingerprint, 0)),
  CHECK (COALESCE(json_type(plan, '$.fingerprintAlgorithm') = 'text' AND json_extract(plan, '$.fingerprintAlgorithm') = fingerprint_algorithm, 0)),
  CHECK (COALESCE(json_type(plan, '$.checks') = 'array', 0)),
  CHECK (COALESCE(json_type(plan, '$.decisions') = 'array', 0)),
  CHECK (COALESCE((supersedes_revision_id IS NULL AND json_type(plan, '$.supersedesRevisionId') IS NULL)
      OR (supersedes_revision_id IS NOT NULL AND json_type(plan, '$.supersedesRevisionId') = 'text'
          AND json_extract(plan, '$.supersedesRevisionId') = supersedes_revision_id), 0)),
  CHECK ((revision = 1 AND reason = 'initial') OR (revision > 1 AND reason <> 'initial'))
);
CREATE INDEX idx_verification_plan_revisions_request
  ON verification_plan_revisions(execution_request_id, revision);

CREATE TRIGGER verification_plan_revision_binding_insert
BEFORE INSERT ON verification_plan_revisions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runs r
      WHERE r.id = NEW.session_id AND r.execution_request_id = NEW.execution_request_id
  ) THEN RAISE(ABORT, 'verification revision session/request mismatch') END;
  SELECT CASE WHEN NEW.supersedes_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM verification_plan_revisions p
      WHERE p.id = NEW.supersedes_revision_id
        AND p.session_id = NEW.session_id
        AND p.execution_request_id = NEW.execution_request_id
        AND p.revision = NEW.revision - 1
  ) THEN RAISE(ABORT, 'verification revision predecessor mismatch') END;
  SELECT CASE WHEN NEW.revision = 1 AND NEW.supersedes_revision_id IS NOT NULL
    THEN RAISE(ABORT, 'initial verification revision cannot supersede') END;
  SELECT CASE WHEN NEW.revision > 1 AND NEW.supersedes_revision_id IS NULL
    THEN RAISE(ABORT, 'verification revision predecessor required') END;
END;

CREATE TRIGGER verification_plan_revision_immutable_update
BEFORE UPDATE ON verification_plan_revisions
BEGIN SELECT RAISE(ABORT, 'verification plan revisions are immutable'); END;
CREATE TRIGGER verification_plan_revision_immutable_delete
BEFORE DELETE ON verification_plan_revisions
BEGIN SELECT RAISE(ABORT, 'verification plan revisions are immutable'); END;

CREATE TABLE verification_runs (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES runs(id),
  execution_request_id  TEXT NOT NULL REFERENCES execution_requests(id),
  plan_revision_id      TEXT NOT NULL REFERENCES verification_plan_revisions(id),
  state                 TEXT NOT NULL DEFAULT 'ready'
                          CHECK (state IN ('ready','claimed','completed','interrupted')),
  claim_token           TEXT,
  claimed_at            TEXT,
  evaluation            TEXT CHECK (evaluation IS NULL OR json_valid(evaluation)),
  artifacts             TEXT CHECK (artifacts IS NULL OR json_valid(artifacts)),
  interruption_reason   TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (session_id, plan_revision_id),
  CHECK (claim_token IS NULL OR length(trim(claim_token)) > 0),
  CHECK (interruption_reason IS NULL OR length(trim(interruption_reason)) > 0),
  CHECK ((state = 'ready' AND claim_token IS NULL AND claimed_at IS NULL)
      OR (state <> 'ready' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((state = 'completed' AND evaluation IS NOT NULL AND artifacts IS NOT NULL AND interruption_reason IS NULL)
      OR (state = 'interrupted' AND evaluation IS NULL AND artifacts IS NULL AND interruption_reason IS NOT NULL)
      OR (state IN ('ready','claimed') AND evaluation IS NULL AND artifacts IS NULL AND interruption_reason IS NULL))
);
CREATE INDEX idx_verification_runs_session_state ON verification_runs(session_id, state);

CREATE TRIGGER verification_run_binding_insert
BEFORE INSERT ON verification_runs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM verification_plan_revisions p
      WHERE p.id = NEW.plan_revision_id
        AND p.session_id = NEW.session_id
        AND p.execution_request_id = NEW.execution_request_id
  ) THEN RAISE(ABORT, 'verification run revision binding mismatch') END;
END;
CREATE TRIGGER verification_run_binding_update
BEFORE UPDATE OF session_id, execution_request_id, plan_revision_id ON verification_runs
BEGIN SELECT RAISE(ABORT, 'verification run binding is immutable'); END;
