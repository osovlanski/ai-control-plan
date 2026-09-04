# Fixture: failing-test

**Goal for the agent:** `pnpm test` fails because `add(2, 3)` returns `-1` instead of `5`. Fix `src/add.mjs` so the test passes. Do not change `test.mjs`.

**Done state:**
- `src/add.mjs` changed (the `-` becomes `+`).
- The `test` script (`node test.mjs`) exits 0.
- No other file changed.

Used by the `happy-path` eval scenario (REAL: real Claude, real Codex).
