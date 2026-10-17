-- M4 registry federation: a metadata-only cache of Cockpit's registry v1
-- snapshots. Asset content is not cached here; that belongs to composition
-- time (plan §3.5, risk 8). Nothing in this file holds a token or a secret
-- value: MCP assets carry secret references only (contract v1).

-- One row per distinct snapshot observed. The newest row is the current cache;
-- re-observing an unchanged snapshot refreshes observed_at in place.
CREATE TABLE registry_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,                 -- 'cockpit'
  snapshot_digest TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  asset_count     INTEGER NOT NULL,
  first_seen_at   TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  UNIQUE (source, snapshot_digest)
);

-- An asset revision is its content digest, so (id, digest) is the key.
CREATE TABLE registry_assets (
  asset_id      TEXT NOT NULL,
  digest        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  metadata      TEXT NOT NULL,                   -- the RegistryAsset JSON as served
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, digest)
);

CREATE TABLE registry_snapshot_assets (
  snapshot_id INTEGER NOT NULL REFERENCES registry_snapshots(id) ON DELETE CASCADE,
  asset_id    TEXT NOT NULL,
  digest      TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, asset_id),
  FOREIGN KEY (asset_id, digest) REFERENCES registry_assets(asset_id, digest)
);

-- Sibling of capability_changes, not a reuse: capability_changes.assistant_id
-- is a NOT NULL foreign key to assistants, and an asset is not owned by one
-- assistant (a skill can target several).
CREATE TABLE registry_asset_changes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id        TEXT NOT NULL,
  change          TEXT NOT NULL CHECK (change IN ('added', 'removed', 'digest_changed')),
  old_digest      TEXT,
  new_digest      TEXT,
  snapshot_digest TEXT NOT NULL,
  source          TEXT NOT NULL,                 -- 'cockpit-registry'
  observed_at     TEXT NOT NULL
);
CREATE INDEX idx_registry_asset_changes_asset ON registry_asset_changes(asset_id, observed_at);

-- Last sync attempt per source, so a failure is visible without a log reader.
CREATE TABLE registry_sync_state (
  source            TEXT PRIMARY KEY,
  last_attempt_at   TEXT NOT NULL,
  last_success_at   TEXT,
  last_failure      TEXT                         -- classified reason, never a response body
);
