-- M1 — composition domain (docs/agentic-os-plan.md §4 M1, docs/contracts/composition-v1.md).
--
-- agent_specs is the immutable composition revision. Each row carries the
-- canonical AgentSpec, plus the BundleRequest and BundleResponse it was
-- composed with: the spec binds the bundle only by context.bundle_digest, so
-- the bytes are stored here to keep the revision replayable. Failover and
-- re-composition insert a new revision; they never edit one.
CREATE TABLE agent_specs (
  composition_revision_id TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL REFERENCES tasks(id),
  schema_version          TEXT NOT NULL,
  explanation_ref         TEXT NOT NULL,
  bundle_digest           TEXT NOT NULL,
  spec_json               TEXT NOT NULL,
  bundle_request_json     TEXT NOT NULL,
  bundle_response_json    TEXT NOT NULL,
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_agent_specs_task ON agent_specs(task_id);

CREATE TABLE composition_decisions (
  id                      TEXT PRIMARY KEY,
  composition_revision_id TEXT NOT NULL UNIQUE REFERENCES agent_specs(composition_revision_id),
  decision_json           TEXT NOT NULL,
  created_at              TEXT NOT NULL
);

-- Immutability is a storage rule, not a convention: there is no UPDATE path.
CREATE TRIGGER agent_specs_immutable BEFORE UPDATE ON agent_specs
BEGIN SELECT RAISE(ABORT, 'agent_specs rows are immutable; compose a new revision'); END;
CREATE TRIGGER agent_specs_undeletable BEFORE DELETE ON agent_specs
BEGIN SELECT RAISE(ABORT, 'agent_specs rows are immutable; compose a new revision'); END;
CREATE TRIGGER composition_decisions_immutable BEFORE UPDATE ON composition_decisions
BEGIN SELECT RAISE(ABORT, 'composition_decisions rows are immutable'); END;
CREATE TRIGGER composition_decisions_undeletable BEFORE DELETE ON composition_decisions
BEGIN SELECT RAISE(ABORT, 'composition_decisions rows are immutable'); END;

-- NULL on every pre-033 run, and it stays NULL: those runs had no composition.
-- Set at most once; a run never moves to another revision.
ALTER TABLE runs ADD COLUMN composition_revision_id TEXT REFERENCES agent_specs(composition_revision_id);
CREATE TRIGGER runs_composition_revision_write_once
BEFORE UPDATE OF composition_revision_id ON runs
WHEN OLD.composition_revision_id IS NOT NULL AND NEW.composition_revision_id IS NOT OLD.composition_revision_id
BEGIN SELECT RAISE(ABORT, 'runs.composition_revision_id is write-once'); END;

-- Per-asset usage events (plan §3.5 AssetUsage). The table lands here; M6/M10
-- write it. Attachment, invocation and outcome are separate facts.
CREATE TABLE asset_usage (
  event_id           TEXT PRIMARY KEY,
  asset_id           TEXT NOT NULL,
  asset_digest       TEXT NOT NULL,
  run_id             TEXT NOT NULL REFERENCES runs(id),
  attached           INTEGER NOT NULL CHECK(attached IN (0, 1)),
  invocation_count   INTEGER NOT NULL CHECK(invocation_count >= 0),
  outcome            TEXT,
  attribution_method TEXT NOT NULL,
  at                 TEXT NOT NULL
);
CREATE INDEX idx_asset_usage_run ON asset_usage(run_id);
CREATE INDEX idx_asset_usage_asset ON asset_usage(asset_id, asset_digest);
CREATE TRIGGER asset_usage_immutable BEFORE UPDATE ON asset_usage
BEGIN SELECT RAISE(ABORT, 'asset_usage rows are immutable'); END;
CREATE TRIGGER asset_usage_undeletable BEFORE DELETE ON asset_usage
BEGIN SELECT RAISE(ABORT, 'asset_usage rows are immutable'); END;

-- The UsageRecord ingestion boundary (plan §3.5, M11 posts into it). The
-- idempotency key is provider-qualified: (provider, event_id), so an eventId
-- MUST be unique per provider, not only within a session. body_digest is
-- the sha256 of the canonical record, so a replay is recognised and a
-- different body under the same key is refused rather than overwritten.
CREATE TABLE usage_records (
  provider           TEXT NOT NULL,
  event_id           TEXT NOT NULL,
  body_digest        TEXT NOT NULL,
  run_id             TEXT REFERENCES runs(id),
  session_ref        TEXT,
  source             TEXT NOT NULL,
  assistant_id       TEXT NOT NULL,
  model              TEXT NOT NULL,
  accounting         TEXT NOT NULL CHECK(accounting IN ('delta', 'cumulative')),
  tokens_in          INTEGER NOT NULL CHECK(tokens_in >= 0),
  tokens_out         INTEGER NOT NULL CHECK(tokens_out >= 0),
  cached_tokens      INTEGER NOT NULL CHECK(cached_tokens >= 0),
  cost_usd           REAL CHECK(cost_usd IS NULL OR cost_usd >= 0),
  api_equivalent_usd REAL NOT NULL CHECK(api_equivalent_usd >= 0),
  pricing_version    TEXT NOT NULL,
  observed_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX idx_usage_records_session ON usage_records(provider, session_ref);
CREATE INDEX idx_usage_records_run ON usage_records(run_id);
CREATE TRIGGER usage_records_immutable BEFORE UPDATE ON usage_records
BEGIN SELECT RAISE(ABORT, 'usage_records rows are immutable'); END;
-- Delete-then-reinsert would be an overwrite under the same key.
CREATE TRIGGER usage_records_undeletable BEFORE DELETE ON usage_records
BEGIN SELECT RAISE(ABORT, 'usage_records rows are immutable'); END;
