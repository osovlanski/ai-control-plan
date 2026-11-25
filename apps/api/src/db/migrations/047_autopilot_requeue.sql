-- An operator's decision to retry a `blocked` attempt (e.g. an approval that expired in an
-- unattended run). `blocked` stays final (the final-is-final trigger is untouched); these columns
-- only mark it as retryable, like `failed`, and it still counts toward attemptsPerItem.
ALTER TABLE autopilot_attempts ADD COLUMN requeued_at TEXT;
ALTER TABLE autopilot_attempts ADD COLUMN requeued_by TEXT;
