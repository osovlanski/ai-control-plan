-- M16 K19d — the second half of a judging provider's own token accounting.
--
-- §7.1(4) asks for measured cost per 1,000 decisions, and cost is input AND
-- output tokens at different prices; `input_tokens` (025) alone cannot give
-- it. NULL on every row whose provider made no metered call (rules) and on
-- every pre-K19d row: a backfilled count would be a fabricated one.
ALTER TABLE decision_records ADD COLUMN output_tokens INTEGER;
