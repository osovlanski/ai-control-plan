-- K4b: durable resource-slot waits. Widening the `kind` CHECK needs a table
-- rebuild, so the 017 pattern is repeated: rebuild under deferred foreign keys,
-- verify the final graph explicitly, then clear the deferral.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE wait_conditions_k4b (
 task_id TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL CHECK(generation > 0),
 state TEXT NOT NULL CHECK(state IN ('active','consumed','replaced','cancelled','expired')),
 kind TEXT NOT NULL CHECK(kind IN ('time','quota','dependency','resource')), not_before TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, auto_wakes INTEGER NOT NULL DEFAULT 0,
 history TEXT NOT NULL DEFAULT '[]', consumed_at TEXT, consumed_by TEXT, reason TEXT NOT NULL,
 checkpoint_id TEXT REFERENCES checkpoints(id), blockers TEXT NOT NULL DEFAULT '[]',
 assistants TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]',
 on_dependency_failure TEXT CHECK(on_dependency_failure IN ('cancel','wake-anyway','wait-input')),
 origin TEXT,
 -- The named pool this wait needs units of, and how many. Both are intent (I-S1),
 -- never a resolved execution choice; capacity lives in config and is re-read at
 -- every wake.
 --
 -- The requirement is INDEPENDENT of `kind`, because it outlives any one
 -- condition: a task that claimed a slot and then yields on context or re-parks on
 -- quota still needs that slot to run, so the successor condition carries the
 -- requirement forward and must re-acquire. `kind = 'resource'` means the slot is
 -- the ONLY thing it waits for.
 resource TEXT, resource_units INTEGER CHECK(resource_units IS NULL OR resource_units > 0),
 -- When THIS requirement first started waiting for the pool, which is not when
 -- this condition was created: a requirement carried across a quota re-park, a
 -- context continuation or a recovery re-park keeps the age it has been waiting
 -- with, so re-parking can never make it younger than work that arrived later.
 -- `created_at` keeps meaning what it always meant (when this row was written),
 -- and a genuinely new requirement starts at now. Nothing is backfilled: no row
 -- before this migration ever held a pool requirement.
 resource_queued_at TEXT,
 -- The continuation intent a manual handoff or an automatic failover had when it
 -- had to defer for a slot (operator target, assistant handed off from, reason,
 -- handoffs audit label). Durable because the grant may be minutes and a restart
 -- away, and an operator decision that survives neither is not a decision. It is
 -- intent only: routing still runs fresh at the grant.
 continuation TEXT,
 CHECK((resource IS NULL) = (resource_units IS NULL)),
 CHECK((resource IS NULL) = (resource_queued_at IS NULL)),
 CHECK(kind != 'resource' OR resource IS NOT NULL),
 PRIMARY KEY(task_id,generation)
);
INSERT INTO wait_conditions_k4b(task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,consumed_at,consumed_by,reason,checkpoint_id,blockers,assistants,depends_on,on_dependency_failure,origin)
 SELECT task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,consumed_at,consumed_by,reason,checkpoint_id,blockers,assistants,depends_on,on_dependency_failure,origin FROM wait_conditions;
DROP TABLE wait_conditions;
ALTER TABLE wait_conditions_k4b RENAME TO wait_conditions;
CREATE UNIQUE INDEX uq_wait_active ON wait_conditions(task_id) WHERE state = 'active';
CREATE INDEX idx_wait_due ON wait_conditions(not_before) WHERE state = 'active';
CREATE INDEX idx_wait_dependency ON wait_conditions(kind) WHERE state = 'active' AND kind = 'dependency';
-- Serves the FIFO queue scan: active waits naming one pool, oldest REQUIREMENT
-- first (resource_queued_at, not the condition's own created_at).
CREATE INDEX idx_wait_resource ON wait_conditions(resource, resource_queued_at, task_id) WHERE state = 'active' AND resource IS NOT NULL;

-- One row per granted claim. The claim is committed in the SAME transaction as
-- the wake's condition-consume and `dispatches` insert, so two concurrent wakes
-- can never both consume the final slot: the partial unique index plus the
-- in-transaction capacity sum are the whole protocol. No lease, no TTL — release
-- is driven by the existing `runs`/`dispatches` ownership record, which already
-- has crash recovery, so a claim cannot outlive the ownership it was granted for.
CREATE TABLE resource_claims (
 claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id),
 generation INTEGER NOT NULL,
 resource TEXT NOT NULL,
 units INTEGER NOT NULL CHECK(units > 0),
 claimed_at TEXT NOT NULL,
 released_at TEXT,
 release_reason TEXT,
 FOREIGN KEY(task_id, generation) REFERENCES wait_conditions(task_id, generation)
);
-- A task holds at most one live claim; a dispatch claims at most once ever.
CREATE UNIQUE INDEX uq_claim_live ON resource_claims(task_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX uq_claim_dispatch ON resource_claims(dispatch_id);
CREATE INDEX idx_claim_live_resource ON resource_claims(resource) WHERE released_at IS NULL;
CREATE TEMP TABLE k4b_migration_fk_check (violations INTEGER NOT NULL CHECK(violations = 0));
INSERT INTO k4b_migration_fk_check SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE k4b_migration_fk_check;
PRAGMA defer_foreign_keys = OFF;
