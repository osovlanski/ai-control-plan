-- M16 K19c — what the tool gate DID with each decision (plan §5 K19).
--
-- Additive columns on the append-only `decision_records`; still no UPDATE or
-- DELETE. NULL on every pre-K19c row and on any non-gate site: the gate did
-- not exist then, and a backfilled outcome would be a fabricated one.
--
-- gate_outcome : block | auto-approve | prompt | unchanged — in `shadow` mode
--                this is the outcome that WOULD have applied; the prompt rate
--                K22 charts is COUNT(gate_outcome = 'prompt') / COUNT(*) per
--                session (see `toolGatePromptRates`).
-- gate_reason  : the §5 K19 mapping row that fired. An absent answer and a
--                measured low value read differently here ("no basis (answer
--                absent): risk" vs "judged: risk=low").
-- gate_hook    : pre-exec (the adapter's approval round-trip, before the tool
--                runs) | post-start (`tool.started`, after it began).
-- gate_tier    : preventive | audit — the enforcement the hook can actually
--                perform. A post-start evaluation is audit, whatever the mode.
ALTER TABLE decision_records ADD COLUMN gate_outcome TEXT
  CHECK(gate_outcome IS NULL OR gate_outcome IN ('block','auto-approve','prompt','unchanged'));
ALTER TABLE decision_records ADD COLUMN gate_reason TEXT;
ALTER TABLE decision_records ADD COLUMN gate_hook TEXT
  CHECK(gate_hook IS NULL OR gate_hook IN ('pre-exec','post-start'));
ALTER TABLE decision_records ADD COLUMN gate_tier TEXT
  CHECK(gate_tier IS NULL OR gate_tier IN ('preventive','audit'));
CREATE INDEX idx_decision_records_session ON decision_records(session_id);
