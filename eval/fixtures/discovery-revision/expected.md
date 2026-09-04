# Fixture: discovery-revision

**Goal for the agent:** add a `lint` script to `package.json` (`"lint": "node lint.mjs"`) and remove the `TODO` marker from `src/clean.mjs` so `lint.mjs` passes.

**Done state:**
- `package.json` `scripts.lint` exists and runs `lint.mjs`.
- `src/clean.mjs` no longer contains the string `TODO`.
- Both `test` and `lint` scripts exit 0.

**Why this fixture exists (increment 3, D7/R4):** the initial verification plan is discovered from the *initial* `package.json`, which has no `lint` script. The goal's own change adds one. `VerificationCoordinator` compares the initial and post-change discovered check sets and must write a **superseding** `verification_plan_revisions` row for the newly-discovered `lint` check — this is the real revision mechanism (a discovery-comparison, not a reaction to a failed check). Used by the `replan-needed` eval scenario (REAL).
