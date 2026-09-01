-- Target is execution-affecting and fingerprinted. It is set on first INSERT;
-- accepted legacy/untargeted requests are intentionally not backfilled.
ALTER TABLE execution_requests ADD COLUMN target_kind   TEXT CHECK(target_kind IN ('repository', 'worktree'));
ALTER TABLE execution_requests ADD COLUMN workspace_id  TEXT REFERENCES workspace_identities(id);
ALTER TABLE execution_requests ADD COLUMN repository_id TEXT REFERENCES repository_identities(id);
ALTER TABLE execution_requests ADD COLUMN worktree_id   TEXT REFERENCES worktree_identities(id);

CREATE INDEX idx_execution_requests_repository ON execution_requests(repository_id) WHERE repository_id IS NOT NULL;
CREATE INDEX idx_execution_requests_worktree ON execution_requests(worktree_id) WHERE worktree_id IS NOT NULL;

CREATE TRIGGER execution_request_target_insert
BEFORE INSERT ON execution_requests
BEGIN
  SELECT CASE
    WHEN NEW.target_kind IS NULL AND (NEW.workspace_id IS NOT NULL OR NEW.repository_id IS NOT NULL OR NEW.worktree_id IS NOT NULL)
      THEN RAISE(ABORT, 'execution target kind missing')
    WHEN NEW.target_kind IS NOT NULL AND (NEW.workspace_id IS NULL OR NEW.repository_id IS NULL)
      THEN RAISE(ABORT, 'execution target identity incomplete')
    WHEN NEW.target_kind = 'repository' AND NEW.worktree_id IS NOT NULL
      THEN RAISE(ABORT, 'repository target cannot include worktree')
    WHEN NEW.target_kind = 'worktree' AND NEW.worktree_id IS NULL
      THEN RAISE(ABORT, 'worktree target identity incomplete')
    WHEN NEW.repository_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM repository_identities r WHERE r.id = NEW.repository_id AND r.workspace_id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'repository target outside workspace')
    WHEN NEW.worktree_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM worktree_identities w WHERE w.id = NEW.worktree_id AND w.repository_id = NEW.repository_id
    ) THEN RAISE(ABORT, 'worktree target outside repository')
  END;
END;

CREATE TRIGGER execution_request_target_update
BEFORE UPDATE OF target_kind, workspace_id, repository_id, worktree_id ON execution_requests
BEGIN
  SELECT RAISE(ABORT, 'execution target is immutable');
END;
