-- A pending approval whose session reaches a terminal state is settled in the
-- same transaction: state 'expired' (no longer answerable) plus the reason, so a
-- client polling approval state never sees a live request on a dead session.
-- NULL for rows expired by the approval deadline or written before this column.
ALTER TABLE approvals ADD COLUMN settled_reason TEXT;
