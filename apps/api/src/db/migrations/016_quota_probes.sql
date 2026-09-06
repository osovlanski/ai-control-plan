-- K3: idle quota probes. One attempt row per assistant so the 15-minute rate
-- limit and probe freshness survive a restart. Probe *results* stay in
-- quota_snapshots (source = 'provider-api'); this table holds attempts only,
-- so an unavailable endpoint changes nothing the projection reads.
CREATE TABLE quota_probes (
  assistant_id TEXT PRIMARY KEY REFERENCES assistants(id),
  attempted_at TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK(outcome IN ('ok','unavailable','unauthorized','unsupported')),
  -- Classified reason only. Credentials are read in memory and never stored.
  detail       TEXT
);
