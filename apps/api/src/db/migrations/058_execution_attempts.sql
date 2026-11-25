-- qcq-04a: execution attempts own resource claims (docs/agentic-os-qcq-review-packet.md 2.1, 2.3, 2.3.1).
-- One provider execution is one attempt row, created before any provider call. Its claims live and
-- die with it. The K4b rebuild pattern (017/023): rebuild under deferred foreign keys, verify the
-- final graph explicitly, then clear the deferral.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE execution_attempts (
 attempt_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 kind TEXT NOT NULL CHECK(kind IN ('dispatch','direct','candidate')),
 execution_path TEXT NOT NULL CHECK(execution_path IN ('harness','legacy')),
 dispatch_id TEXT REFERENCES dispatches(dispatch_id),
 candidate_slot INTEGER NOT NULL DEFAULT 0,
 assistant_id TEXT,
 routing_decision_id INTEGER,
 run_as TEXT NOT NULL CHECK(run_as IN ('plane','agent')),
 account_key TEXT,
 account_source TEXT NOT NULL CHECK(account_source IN ('declared','fallback','none','unresolved','pending')),
 account_config_hash TEXT,
 queue_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','held','starting','live','stopping','ambiguous','settled','dropped')),
 session_id TEXT REFERENCES runs(id),
 launch_plan_json TEXT,
 entered_at TEXT,
 entered_boot_id TEXT,
 stop_requested_at TEXT,
 provider_unit TEXT,
 provider_unit_seen_at TEXT,
 exit_proof TEXT CHECK(exit_proof IN ('cgroup_empty','unscoped_exit','host_rebooted','operator_confirmed',
                                      'never_entered','stream_closed_unverified','boot_unverified',
                                      'task_terminal_unverified','migrated_historical')),
 occupies_account TEXT,
 exit_proof_at TEXT,
 predecessor_id TEXT REFERENCES execution_attempts(attempt_id),
 inherited_hops INTEGER NOT NULL DEFAULT 0,
 deadline_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, final_at TEXT, reason TEXT,
 CHECK((account_key IS NULL) = (account_source IN ('none','unresolved','pending'))),
 CHECK(kind != 'dispatch' OR dispatch_id IS NOT NULL OR state IN ('queued','settled','dropped')),
 -- queued and held prove no entry (the entry invariant, 2.1)
 CHECK(state NOT IN ('queued','held') OR (entered_at IS NULL AND exit_proof IS NULL)),
 CHECK(state IN ('queued','held','dropped') OR entered_at IS NOT NULL),
 CHECK(state != 'dropped' OR COALESCE(exit_proof, '') = 'never_entered'),
 CHECK(state != 'settled' OR COALESCE(exit_proof, '') IN ('cgroup_empty','unscoped_exit','host_rebooted',
                                                          'operator_confirmed','stream_closed_unverified',
                                                          'boot_unverified','task_terminal_unverified',
                                                          'migrated_historical')),
 CHECK(COALESCE(exit_proof, '') NOT IN ('stream_closed_unverified','boot_unverified','task_terminal_unverified')
       OR account_key IS NULL),
 CHECK(occupies_account IS NULL OR account_key IS NULL),
 CHECK(entered_at IS NULL OR entered_boot_id IS NOT NULL OR attempt_id LIKE 'att_mig_%')
);
CREATE UNIQUE INDEX uq_attempt_dispatch ON execution_attempts(dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE UNIQUE INDEX uq_attempt_session ON execution_attempts(session_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX uq_attempt_owner ON execution_attempts(task_id, candidate_slot)
 WHERE state IN ('held','starting','live','stopping','ambiguous');
CREATE UNIQUE INDEX uq_attempt_queued ON execution_attempts(task_id, candidate_slot) WHERE state = 'queued';
CREATE INDEX idx_attempt_queue ON execution_attempts(queue_key, task_id, candidate_slot) WHERE state = 'queued';
CREATE INDEX idx_attempt_task ON execution_attempts(task_id, state);

CREATE TABLE attempt_requirements (
 attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
 resource TEXT NOT NULL,
 units INTEGER NOT NULL CHECK(units > 0),
 queued_at TEXT NOT NULL,
 PRIMARY KEY(attempt_id, resource)
);
CREATE INDEX idx_requirement_resource ON attempt_requirements(resource, attempt_id);

-- ------------------------------------------------------------ backfill (2.3.1) --
-- A named abort: SQLite raises only inside a trigger, so the classification writes its
-- unclassifiable rows here and the trigger aborts the whole migration with their ids.
CREATE TEMP TABLE qcq_abort (msg TEXT NOT NULL);
CREATE TEMP TRIGGER qcq_abort_raise BEFORE INSERT ON qcq_abort BEGIN SELECT RAISE(ABORT, NEW.msg); END;

-- A run row has not ended when no vocabulary says so: no `ended_at`, no legacy end state, no
-- terminal session state. This decides rows 1 and 2 for a dispatch-bound run whatever its task's
-- state (#264 review finding 3: a cancelled task's open run with a released claim is row 1).
CREATE TEMP VIEW qcq_unended_runs AS
SELECT r.id FROM runs r
 WHERE r.ended_at IS NULL AND r.state NOT IN ('ENDED_OK','ENDED_ERROR','CANCELLED')
   AND (r.execution_request_id IS NULL OR COALESCE(r.session_state, '') NOT IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT','YIELDED'));
-- An unmatched run (no dispatch row carries it) gets an attempt only while its task is not
-- terminal (K4b releases at task terminal).
CREATE TEMP VIEW qcq_open_runs AS
SELECT r.id FROM runs r JOIN tasks t ON t.id = r.task_id
 WHERE r.id IN (SELECT id FROM qcq_unended_runs)
   AND t.state NOT IN ('COMPLETED','FAILED','CANCELLED');

-- Every dispatch that has a claim row or an entry mark. A dispatch with neither gets no attempt.
CREATE TEMP TABLE qcq_src AS
SELECT d.dispatch_id, d.task_id, d.execution_path, d.phase, d.created_at AS dispatch_created_at,
       d.routing_decision_id, d.condition_generation,
       (SELECT MIN(e.at) FROM scheduler_events e WHERE e.dispatch_id = d.dispatch_id AND e.type = 'dispatch.start_attempted') AS mark_at,
       EXISTS (SELECT 1 FROM scheduler_events e WHERE e.dispatch_id = d.dispatch_id AND e.type = 'dispatch.aborted'
                 AND json_extract(e.payload, '$.reason') = 'Operator confirmed no live execution owner') AS confirmed,
       c.claim_id, c.released_at AS claim_released_at, c.resource, c.units, c.claimed_at,
       r.id AS run_id, r.started_at AS run_started_at, r.id IN (SELECT id FROM qcq_unended_runs) AS run_open, r.assistant_id AS run_assistant
  FROM dispatches d
  LEFT JOIN resource_claims c ON c.dispatch_id = d.dispatch_id
  LEFT JOIN runs r ON r.dispatch_id = d.dispatch_id
 WHERE c.claim_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM scheduler_events e WHERE e.dispatch_id = d.dispatch_id AND e.type = 'dispatch.start_attempted');

-- First match wins, rows ordered by evidence of entry, then by the claim.
CREATE TEMP TABLE qcq_rows AS
SELECT s.*,
  CASE
    WHEN run_id IS NOT NULL AND run_open THEN '1'
    WHEN run_id IS NOT NULL THEN '2'
    WHEN execution_path = 'legacy' AND mark_at IS NOT NULL AND NOT confirmed THEN '3'
    WHEN execution_path = 'legacy' AND mark_at IS NOT NULL THEN '3b'
    WHEN execution_path = 'harness' AND mark_at IS NOT NULL AND claim_id IS NOT NULL THEN '4'
    WHEN execution_path = 'harness' AND mark_at IS NOT NULL THEN '5'
    WHEN claim_id IS NOT NULL AND claim_released_at IS NULL AND phase = 'reserved' THEN '6'
    WHEN claim_id IS NOT NULL THEN '7'
    ELSE '8'
  END AS row_class
  FROM qcq_src s;

INSERT INTO qcq_abort
SELECT 'qcq_backfill_unclassified: dispatch ' || dispatch_id || ' claim ' || IFNULL(claim_id, 'none')
  FROM qcq_rows WHERE row_class = '8';

CREATE TEMP TABLE qcq_attempts AS
SELECT
  CASE WHEN claim_id IS NOT NULL THEN 'att_mig_' || claim_id ELSE 'att_mig_d_' || dispatch_id END AS attempt_id,
  q.task_id, 'dispatch' AS kind, q.execution_path, q.dispatch_id, 0 AS candidate_slot,
  COALESCE(q.run_assistant, (SELECT er.assistant_id FROM execution_requests er WHERE er.id = q.dispatch_id)) AS assistant_id,
  q.routing_decision_id,
  CASE WHEN (SELECT t.run_as FROM tasks t WHERE t.id = q.task_id) = 'agent' THEN 'agent' ELSE 'plane' END AS run_as,
  COALESCE((SELECT w.resource_queued_at FROM wait_conditions w WHERE w.task_id = q.task_id AND w.generation = q.condition_generation),
           q.dispatch_created_at) AS queue_key,
  CASE row_class WHEN '1' THEN 'live' WHEN '2' THEN 'settled' WHEN '3' THEN 'ambiguous' WHEN '3b' THEN 'settled'
                 WHEN '4' THEN 'dropped' WHEN '6' THEN 'held' WHEN '7' THEN 'dropped' END AS state,
  CASE WHEN row_class IN ('1','2') THEN q.run_id END AS session_id,
  CASE WHEN row_class IN ('1','2') THEN q.run_started_at WHEN row_class IN ('3','3b') THEN q.mark_at END AS entered_at,
  CASE row_class WHEN '2' THEN 'migrated_historical' WHEN '3b' THEN 'operator_confirmed'
                 WHEN '4' THEN 'never_entered' WHEN '7' THEN 'never_entered' END AS exit_proof,
  CASE WHEN row_class IN ('2','3b','4','7') THEN COALESCE(q.claim_released_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) END AS final_at,
  CASE WHEN row_class IN ('1','3') AND q.claim_id IS NOT NULL AND q.claim_released_at IS NOT NULL THEN 'k4b_released_before_upgrade'
       ELSE 'migrated: backfill row ' || row_class END AS reason,
  q.dispatch_created_at AS created_at,
  q.claim_id, q.claim_released_at, q.resource, q.units, q.claimed_at, row_class
  FROM qcq_rows q WHERE row_class != '5';

-- Two dispatch owners on one slot already break K4b's own one-active-dispatch rule: the operator
-- reconciles before upgrading, rather than the migration guessing which one is real.
INSERT INTO qcq_abort
SELECT 'qcq_backfill_two_owners: task ' || task_id || ' slot ' || candidate_slot || ' has ' || COUNT(*) || ' open owners'
  FROM qcq_attempts WHERE state IN ('held','live','ambiguous')
 GROUP BY task_id, candidate_slot HAVING COUNT(*) > 1;

-- Every run or session still open with no attempt yet: direct starts, candidates, pre-upgrade runs.
-- On a compare or race, slots 1..n by start time, then run id (stable tie-break). On a single task
-- the first free slot is 0; a pre-upgrade database can also hold extra open runs on one single task
-- (a crash left a legacy run open, which boot reconcile ends after the upgrade). Each extra run is
-- kept as an owner on the next slot rather than released or guessed away: boot reconcile ends the
-- legacy run, and the boot sweep then settles its attempt with boot_unverified.
CREATE TEMP TABLE qcq_run_attempts AS
SELECT 'att_mig_run_' || r.id AS attempt_id, r.task_id,
       CASE WHEN t.mode = 'single' THEN 'direct' ELSE 'candidate' END AS kind,
       CASE WHEN r.execution_request_id IS NOT NULL THEN 'harness' ELSE 'legacy' END AS execution_path,
       CASE WHEN t.mode = 'single' THEN
              (SELECT COUNT(*) FROM qcq_attempts a WHERE a.task_id = r.task_id AND a.candidate_slot = 0
                  AND a.state IN ('held','live','ambiguous'))
              + ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.started_at, r.id) - 1
            ELSE ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.started_at, r.id) END AS candidate_slot,
       r.assistant_id, CASE WHEN t.run_as = 'agent' THEN 'agent' ELSE 'plane' END AS run_as,
       r.started_at AS queue_key, r.id AS session_id, r.started_at AS entered_at, r.started_at AS created_at
  FROM runs r JOIN tasks t ON t.id = r.task_id
 WHERE r.id IN (SELECT id FROM qcq_open_runs)
   AND NOT EXISTS (SELECT 1 FROM qcq_attempts a WHERE a.session_id = r.id);

INSERT INTO execution_attempts(attempt_id, task_id, kind, execution_path, dispatch_id, candidate_slot, assistant_id,
  routing_decision_id, run_as, account_source, queue_key, state, session_id, entered_at, exit_proof, exit_proof_at,
  created_at, updated_at, final_at, reason)
SELECT attempt_id, task_id, kind, execution_path, dispatch_id, candidate_slot, assistant_id, routing_decision_id, run_as,
       'unresolved', queue_key, state, session_id, entered_at, exit_proof, final_at, created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), final_at, reason
  FROM qcq_attempts;

INSERT INTO execution_attempts(attempt_id, task_id, kind, execution_path, candidate_slot, assistant_id, run_as,
  account_source, queue_key, state, session_id, entered_at, created_at, updated_at, reason)
SELECT attempt_id, task_id, kind, execution_path, candidate_slot, assistant_id, run_as, 'unresolved', queue_key, 'live',
       session_id, entered_at, created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       CASE WHEN kind = 'direct' AND candidate_slot > 0 THEN 'migrated: extra open run on a single task'
            ELSE 'migrated: open run' END
  FROM qcq_run_attempts;

-- An owner keeps the requirement its live K4b claim satisfies. An owner whose claim K4b already
-- released holds zero pool units, exactly K4b's view of that pool before the upgrade.
INSERT INTO attempt_requirements(attempt_id, resource, units, queued_at)
SELECT attempt_id, resource, units, COALESCE(queue_key, claimed_at)
  FROM qcq_attempts WHERE state IN ('held','live','ambiguous') AND claim_id IS NOT NULL AND claim_released_at IS NULL;

-- ---------------------------------------------------- resource_claims rebuild --
CREATE TABLE resource_claims_qcq (
 claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
 attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
 task_id TEXT NOT NULL REFERENCES tasks(id),
 dispatch_id TEXT REFERENCES dispatches(dispatch_id),
 generation INTEGER,
 resource TEXT NOT NULL,
 units INTEGER NOT NULL CHECK(units > 0),
 account_source TEXT,
 claimed_at TEXT NOT NULL,
 released_at TEXT,
 release_reason TEXT,
 FOREIGN KEY(task_id, generation) REFERENCES wait_conditions(task_id, generation)
);
INSERT INTO resource_claims_qcq(claim_id, attempt_id, task_id, dispatch_id, generation, resource, units, claimed_at, released_at, release_reason)
SELECT c.claim_id, 'att_mig_' || c.claim_id, c.task_id, c.dispatch_id, c.generation, c.resource, c.units, c.claimed_at,
       CASE WHEN c.released_at IS NULL AND a.state IN ('settled','dropped') THEN a.final_at ELSE c.released_at END,
       CASE WHEN c.released_at IS NULL AND a.state IN ('settled','dropped') THEN 'qcq-04 migration: ' || a.reason ELSE c.release_reason END
  FROM resource_claims c JOIN execution_attempts a ON a.attempt_id = 'att_mig_' || c.claim_id;
INSERT INTO qcq_abort
SELECT 'qcq_backfill_unclassified: claim ' || c.claim_id || ' dispatch ' || c.dispatch_id
  FROM resource_claims c WHERE NOT EXISTS (SELECT 1 FROM execution_attempts a WHERE a.attempt_id = 'att_mig_' || c.claim_id);
DROP TABLE resource_claims;
ALTER TABLE resource_claims_qcq RENAME TO resource_claims;
CREATE UNIQUE INDEX uq_claim_live ON resource_claims(attempt_id, resource) WHERE released_at IS NULL;
CREATE UNIQUE INDEX uq_claim_dispatch ON resource_claims(dispatch_id, resource) WHERE dispatch_id IS NOT NULL;
CREATE INDEX idx_claim_live_resource ON resource_claims(resource) WHERE released_at IS NULL;
CREATE INDEX idx_claim_attempt ON resource_claims(attempt_id);

-- ---------------------------------------------------- wait_conditions rebuild --
-- attempt_id: the queued attempt a single-path resource wait waits on (qcq-04b). window_json:
-- the qcq-05 window bound. The CHECK is widened so a wait can be on an account alone.
CREATE TABLE wait_conditions_qcq (
 task_id TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL CHECK(generation > 0),
 state TEXT NOT NULL CHECK(state IN ('active','consumed','replaced','cancelled','expired')),
 kind TEXT NOT NULL CHECK(kind IN ('time','quota','dependency','resource')), not_before TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, auto_wakes INTEGER NOT NULL DEFAULT 0,
 history TEXT NOT NULL DEFAULT '[]', consumed_at TEXT, consumed_by TEXT, reason TEXT NOT NULL,
 checkpoint_id TEXT REFERENCES checkpoints(id), blockers TEXT NOT NULL DEFAULT '[]',
 assistants TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]',
 on_dependency_failure TEXT CHECK(on_dependency_failure IN ('cancel','wake-anyway','wait-input')),
 origin TEXT,
 resource TEXT, resource_units INTEGER CHECK(resource_units IS NULL OR resource_units > 0),
 resource_queued_at TEXT,
 continuation TEXT,
 attempt_id TEXT REFERENCES execution_attempts(attempt_id),
 window_json TEXT,
 CHECK((resource IS NULL) = (resource_units IS NULL)),
 CHECK((resource IS NULL) = (resource_queued_at IS NULL)),
 CHECK(kind != 'resource' OR resource IS NOT NULL OR attempt_id IS NOT NULL),
 PRIMARY KEY(task_id,generation)
);
INSERT INTO wait_conditions_qcq(task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,consumed_at,consumed_by,reason,checkpoint_id,blockers,assistants,depends_on,on_dependency_failure,origin,resource,resource_units,resource_queued_at,continuation)
 SELECT task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,consumed_at,consumed_by,reason,checkpoint_id,blockers,assistants,depends_on,on_dependency_failure,origin,resource,resource_units,resource_queued_at,continuation FROM wait_conditions;
DROP TABLE wait_conditions;
ALTER TABLE wait_conditions_qcq RENAME TO wait_conditions;
CREATE UNIQUE INDEX uq_wait_active ON wait_conditions(task_id) WHERE state = 'active';
CREATE INDEX idx_wait_due ON wait_conditions(not_before) WHERE state = 'active';
CREATE INDEX idx_wait_dependency ON wait_conditions(kind) WHERE state = 'active' AND kind = 'dependency';
CREATE INDEX idx_wait_resource ON wait_conditions(resource, resource_queued_at, task_id) WHERE state = 'active' AND resource IS NOT NULL;

-- ----------------------------------------------------------------- triggers --
-- A queued attempt in a slot that has an owner must name that owner as its predecessor, in every
-- write direction, and an owner may not appear beside a queued row that does not name it (2.3).
CREATE TRIGGER trg_attempt_successor BEFORE INSERT ON execution_attempts
WHEN NEW.state = 'queued' AND EXISTS (SELECT 1 FROM execution_attempts o
  WHERE o.task_id = NEW.task_id AND o.candidate_slot = NEW.candidate_slot
    AND o.state IN ('held','starting','live','stopping','ambiguous')
    AND o.attempt_id IS NOT COALESCE(NEW.predecessor_id, ''))
BEGIN SELECT RAISE(ABORT, 'queued attempt in an owned slot must name the owner as predecessor'); END;
CREATE TRIGGER trg_attempt_successor_update BEFORE UPDATE OF predecessor_id, state, task_id, candidate_slot
ON execution_attempts
WHEN NEW.state = 'queued' AND EXISTS (SELECT 1 FROM execution_attempts o
  WHERE o.task_id = NEW.task_id AND o.candidate_slot = NEW.candidate_slot AND o.attempt_id != NEW.attempt_id
    AND o.state IN ('held','starting','live','stopping','ambiguous')
    AND o.attempt_id IS NOT COALESCE(NEW.predecessor_id, ''))
BEGIN SELECT RAISE(ABORT, 'queued attempt in an owned slot must name the owner as predecessor'); END;
CREATE TRIGGER trg_attempt_owner_insert BEFORE INSERT ON execution_attempts
WHEN NEW.state IN ('held','starting','live','stopping','ambiguous') AND EXISTS (SELECT 1 FROM execution_attempts q
  WHERE q.task_id = NEW.task_id AND q.candidate_slot = NEW.candidate_slot AND q.state = 'queued'
    AND q.predecessor_id IS NOT NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'slot holds a queued attempt that is not this owner''s successor'); END;
CREATE TRIGGER trg_attempt_owner_update BEFORE UPDATE OF state ON execution_attempts
WHEN OLD.state IN ('queued','settled','dropped') AND NEW.state IN ('held','starting','live','stopping','ambiguous')
  AND EXISTS (SELECT 1 FROM execution_attempts q
  WHERE q.task_id = NEW.task_id AND q.candidate_slot = NEW.candidate_slot AND q.state = 'queued'
    AND q.attempt_id != NEW.attempt_id AND q.predecessor_id IS NOT NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'slot holds a queued attempt that is not this owner''s successor'); END;
-- An account claim exists only on a Harness attempt in an owner state (Harness-only rule, 2.2).
CREATE TRIGGER trg_claim_account_harness BEFORE INSERT ON resource_claims
WHEN NEW.resource LIKE 'account:%' AND NOT EXISTS (SELECT 1 FROM execution_attempts a
  WHERE a.attempt_id = NEW.attempt_id AND a.execution_path = 'harness'
    AND a.state IN ('held','starting','live','stopping','ambiguous'))
BEGIN SELECT RAISE(ABORT, 'account claim requires a Harness owner attempt'); END;
-- An attempt that ever held an account claim is never settled by a weak proof.
CREATE TRIGGER trg_attempt_weak_proof BEFORE UPDATE OF exit_proof ON execution_attempts
WHEN NEW.exit_proof IN ('stream_closed_unverified','boot_unverified','task_terminal_unverified') AND EXISTS (SELECT 1 FROM resource_claims c
  WHERE c.attempt_id = NEW.attempt_id AND c.resource LIKE 'account:%')
BEGIN SELECT RAISE(ABORT, 'weak exit proof on an account attempt'); END;
-- A claim's identity never changes and a claim row is never deleted; the only update is its release.
CREATE TRIGGER trg_claim_identity BEFORE UPDATE OF attempt_id, resource, units, task_id, dispatch_id ON resource_claims
BEGIN SELECT RAISE(ABORT, 'a claim''s identity is immutable; release it and insert a new one'); END;
CREATE TRIGGER trg_claim_no_delete BEFORE DELETE ON resource_claims
BEGIN SELECT RAISE(ABORT, 'claim history is never deleted'); END;

DROP VIEW qcq_open_runs;
DROP VIEW qcq_unended_runs;
DROP TABLE qcq_src;
DROP TABLE qcq_rows;
DROP TABLE qcq_attempts;
DROP TABLE qcq_run_attempts;
DROP TABLE qcq_abort;

CREATE TEMP TABLE qcq_migration_fk_check (violations INTEGER NOT NULL CHECK(violations = 0));
INSERT INTO qcq_migration_fk_check SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE qcq_migration_fk_check;
PRAGMA defer_foreign_keys = OFF;
