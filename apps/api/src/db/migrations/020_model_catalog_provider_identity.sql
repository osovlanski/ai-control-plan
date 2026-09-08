-- K7 follow-up: provider-safe catalog identity.
--
-- Model ids are not globally unique. Codex (openai) and Cursor both advertise a
-- model whose id is literally `default`, so a catalog keyed on `model_id` alone
-- merged them into one entry and let whichever source ranked higher overwrite
-- the other provider's evidence. Identity is now (provider, model_id).
--
-- These two tables hold nothing but re-derivable evidence — provider discovery
-- manifests, this workspace's own runs, and the pinned price snapshot — so the
-- rows are replaced rather than migrated in place. The catalog rehydrates from
-- local sources on the next read; nothing routing depends on lives here (I-M3).
-- No other table is touched: run identity (migration 019) is untouched history.

DROP TABLE IF EXISTS model_prices;
DROP TABLE IF EXISTS model_catalog;

CREATE TABLE model_catalog (
  provider         TEXT NOT NULL,
  model_id         TEXT NOT NULL,
  source           TEXT NOT NULL,   -- EvidenceSource
  tier             TEXT NOT NULL,   -- EvidenceTier
  observed_at      TEXT NOT NULL,
  catalog_revision TEXT NOT NULL,
  entry_json       TEXT NOT NULL,   -- partial ModelCatalogEntry as observed by this source
  PRIMARY KEY (provider, model_id, source)
);

-- Price EVIDENCE, versioned and bound to the provider whose model it prices.
-- Never an enforcement tariff (§4.4.5): a row here does not authorize bounded
-- maxCostUsd enforcement.
CREATE TABLE model_prices (
  provider         TEXT NOT NULL,
  model_id         TEXT NOT NULL,
  pricing_version  TEXT NOT NULL,
  serving_provider TEXT NOT NULL DEFAULT '*',
  account_kind     TEXT NOT NULL DEFAULT '*',
  source           TEXT NOT NULL,
  tier             TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  price_json       TEXT NOT NULL,   -- ModelPriceEvidence
  PRIMARY KEY (provider, model_id, pricing_version, serving_provider, account_kind)
);
