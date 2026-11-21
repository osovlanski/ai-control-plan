-- tlm-02b — a general task names the GitHub issues and pull requests it belongs to.
--
-- A row is an operator's claim: the plane does not call GitHub to check it, and the read labels it
-- `operator`. Autopilot publications are not copied here: the read derives those links from
-- `autopilot_publications` (and its duplicates) at read time, so there is one source for each.
--
-- GitHub numbers issues and pull requests in one sequence per repository, so repo + number names
-- one object; `kind` records which one the operator meant. An unlink keeps the row (removed_at),
-- and only one live row may exist per task, repo and number.

CREATE TABLE task_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('issue','pull_request')),
  repo TEXT NOT NULL,              -- owner/name, lower case
  number INTEGER NOT NULL CHECK (number > 0),
  relation TEXT NOT NULL CHECK (relation IN ('tracks','implements','closes','related')),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  removed_by TEXT,
  removed_at TEXT
);
CREATE UNIQUE INDEX idx_task_links_live ON task_links(task_id, repo, number) WHERE removed_at IS NULL;
CREATE INDEX idx_task_links_target ON task_links(repo, number);
