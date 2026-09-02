CREATE TABLE workspace_identities (
  singleton   INTEGER PRIMARY KEY CHECK(singleton = 1),
  id          TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE repository_identities (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace_identities(id),
  canonical_git_dir   TEXT NOT NULL,
  remote_fingerprint  TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE(workspace_id, canonical_git_dir)
);

CREATE INDEX repository_identities_remote_idx
  ON repository_identities(workspace_id, remote_fingerprint)
  WHERE remote_fingerprint IS NOT NULL;

CREATE TABLE worktree_identities (
  id                 TEXT PRIMARY KEY,
  repository_id      TEXT NOT NULL REFERENCES repository_identities(id),
  canonical_toplevel TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE(repository_id, canonical_toplevel)
);

CREATE TABLE repository_identity_observations (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id               TEXT NOT NULL REFERENCES repository_identities(id),
  observed_path               TEXT NOT NULL,
  observed_remote_fingerprint TEXT,
  source                      TEXT NOT NULL,
  conflict                    INTEGER NOT NULL DEFAULT 0 CHECK(conflict IN (0, 1)),
  observed_at                 TEXT NOT NULL
);
