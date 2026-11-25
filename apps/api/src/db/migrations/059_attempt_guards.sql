-- #264 review (qcq-04a): close three write paths the 058 guards left open.
-- 1. An owner moved by task_id or candidate_slot into a slot that holds an unrelated queued row.
--    058's owner-update trigger watched only a promotion of state.
DROP TRIGGER trg_attempt_owner_update;
CREATE TRIGGER trg_attempt_owner_update BEFORE UPDATE OF state, task_id, candidate_slot ON execution_attempts
WHEN NEW.state IN ('held','starting','live','stopping','ambiguous')
  AND (OLD.state NOT IN ('held','starting','live','stopping','ambiguous')
       OR OLD.task_id IS NOT NEW.task_id OR OLD.candidate_slot IS NOT NEW.candidate_slot)
  AND EXISTS (SELECT 1 FROM execution_attempts q
  WHERE q.task_id = NEW.task_id AND q.candidate_slot = NEW.candidate_slot AND q.state = 'queued'
    AND q.attempt_id != NEW.attempt_id AND q.predecessor_id IS NOT NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'slot holds a queued attempt that is not this owner''s successor'); END;

-- 2. A claim's whole identity is immutable, including its id, grant time and generation.
DROP TRIGGER trg_claim_identity;
CREATE TRIGGER trg_claim_identity BEFORE UPDATE OF claim_id, attempt_id, resource, units, task_id, dispatch_id, generation, claimed_at
ON resource_claims
BEGIN SELECT RAISE(ABORT, 'a claim''s identity is immutable; release it and insert a new one'); END;

-- 3. INSERT OR REPLACE deletes the conflicting row without firing a DELETE trigger while
--    recursive_triggers is off (the repository connection's default), which erased an account
--    claim's evidence. An insert that would conflict with an existing claim is refused before
--    conflict resolution runs, so no conflict clause can delete a claim.
CREATE TRIGGER trg_claim_no_replace BEFORE INSERT ON resource_claims
WHEN (NEW.claim_id IS NOT NULL AND EXISTS (SELECT 1 FROM resource_claims c WHERE c.claim_id = NEW.claim_id))
  OR (NEW.dispatch_id IS NOT NULL AND EXISTS (SELECT 1 FROM resource_claims c WHERE c.dispatch_id = NEW.dispatch_id AND c.resource = NEW.resource))
  OR (NEW.released_at IS NULL AND EXISTS (SELECT 1 FROM resource_claims c WHERE c.attempt_id = NEW.attempt_id AND c.resource = NEW.resource AND c.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'claim history is never replaced'); END;
