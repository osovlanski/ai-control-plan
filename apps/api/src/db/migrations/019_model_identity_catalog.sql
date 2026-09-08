-- K7 / M12: execution model identity + provider-official model catalog.
--
-- Requested and resolved model identity are separate facts (I-M5). The backfill
-- below only copies values that persisted evidence already proves: the
-- committed execution request for the requested selector, and a persisted
-- `run.started` payload for the resolved identity. Aliases are never resolved
-- through today's catalog, so a run whose provider never reported a model stays
-- NULL — "unknown" is a valid historical answer.

ALTER TABLE runs ADD COLUMN model_requested TEXT;
ALTER TABLE runs ADD COLUMN model_resolved TEXT;
ALTER TABLE runs ADD COLUMN model_resolved_source TEXT;

UPDATE runs SET model_requested = (
  SELECT json_extract(er.model, '$.id') FROM execution_requests er
   WHERE er.id = runs.execution_request_id
) WHERE execution_request_id IS NOT NULL;

UPDATE runs SET
  model_resolved = (
    SELECT json_extract(e.payload, '$.model') FROM events e
     WHERE e.run_id = runs.id AND e.type = 'run.started'
       AND json_extract(e.payload, '$.model') IS NOT NULL
     ORDER BY e.seq LIMIT 1),
  model_resolved_source = 'run.started'
WHERE EXISTS (
  SELECT 1 FROM events e
   WHERE e.run_id = runs.id AND e.type = 'run.started'
     AND json_extract(e.payload, '$.model') IS NOT NULL);

-- Catalog facts, one row per (model, evidence source). Merging happens at read
-- time by EVIDENCE_PRIORITY so a weaker source never overwrites a stronger one.
CREATE TABLE model_catalog (
  model_id         TEXT NOT NULL,
  source           TEXT NOT NULL,   -- EvidenceSource
  provider         TEXT NOT NULL,
  tier             TEXT NOT NULL,   -- EvidenceTier
  observed_at      TEXT NOT NULL,
  catalog_revision TEXT NOT NULL,
  entry_json       TEXT NOT NULL,   -- partial ModelCatalogEntry as observed by this source
  PRIMARY KEY (model_id, source)
);

-- Price EVIDENCE, versioned. Never an enforcement tariff (§4.4.5): the presence
-- of a row here does not authorize bounded maxCostUsd enforcement.
CREATE TABLE model_prices (
  model_id         TEXT NOT NULL,
  pricing_version  TEXT NOT NULL,
  serving_provider TEXT NOT NULL DEFAULT '*',
  account_kind     TEXT NOT NULL DEFAULT '*',
  source           TEXT NOT NULL,
  tier             TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  price_json       TEXT NOT NULL,   -- ModelPriceEvidence
  PRIMARY KEY (model_id, pricing_version, serving_provider, account_kind)
);

-- Refresh attempts are recorded separately from evidence so a failed refresh is
-- visible without corrupting the rows routing still reads (I-M3).
CREATE TABLE model_catalog_refresh (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL,   -- ok | failed | skipped
  detail      TEXT,
  entries     INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX idx_model_catalog_refresh_time ON model_catalog_refresh(started_at DESC);
