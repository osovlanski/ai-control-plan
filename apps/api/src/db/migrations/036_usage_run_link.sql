-- Imported usage joins its run (plan §3.7; phase 7 "one deduped usage stream").
--
-- Cockpit's usage v1 records carry runId null by design, so the plane resolves
-- the run itself: the one run whose assistant has the record's provider and
-- whose provider_session_ref is the record's sessionRef. run_link says how a
-- record's run_id was set:
--   body         the posted record named its run
--   session_ref  the plane resolved it from sessionRef (at ingestion or by the backfill)
-- NULL run_link means the record is not bound to a run.
--
-- usage_records stays immutable except for one write-once step: a record with
-- no run may gain one, together with its run_link. Nothing else may change and
-- a bound record never moves, so a link is never an overwrite.
ALTER TABLE usage_records ADD COLUMN run_link TEXT CHECK(run_link IS NULL OR run_link IN ('body', 'session_ref'));

DROP TRIGGER usage_records_immutable;
UPDATE usage_records SET run_link = 'body' WHERE run_id IS NOT NULL;
CREATE TRIGGER usage_records_immutable BEFORE UPDATE ON usage_records
WHEN NOT (
  OLD.run_id IS NULL AND OLD.run_link IS NULL AND NEW.run_id IS NOT NULL AND NEW.run_link = 'session_ref'
  AND NEW.provider IS OLD.provider AND NEW.event_id IS OLD.event_id AND NEW.body_digest IS OLD.body_digest
  AND NEW.session_ref IS OLD.session_ref AND NEW.source IS OLD.source AND NEW.assistant_id IS OLD.assistant_id
  AND NEW.model IS OLD.model AND NEW.accounting IS OLD.accounting AND NEW.tokens_in IS OLD.tokens_in
  AND NEW.tokens_out IS OLD.tokens_out AND NEW.cached_tokens IS OLD.cached_tokens AND NEW.cost_usd IS OLD.cost_usd
  AND NEW.api_equivalent_usd IS OLD.api_equivalent_usd AND NEW.pricing_version IS OLD.pricing_version
  AND NEW.observed_at IS OLD.observed_at AND NEW.received_at IS OLD.received_at
)
BEGIN SELECT RAISE(ABORT, 'usage_records rows are immutable'); END;

-- The resolution looks runs up by session; the backfill scans unbound records with a session.
CREATE INDEX idx_runs_provider_session_ref ON runs(provider_session_ref) WHERE provider_session_ref IS NOT NULL;
CREATE INDEX idx_usage_records_unbound ON usage_records(provider, session_ref) WHERE run_id IS NULL AND session_ref IS NOT NULL;
