# Hard fixture: lean vs ambient, 2026-11-19

Benchmark of the lean (A) and ambient (D) agent profiles on the hard fixture: the refused-handoff bug, since fixed on `main` by PR #207. Profile definitions are in `s1-results.md`.

## Results (n=2 per arm)

All 4 runs passed the focused test, typecheck and lint.

| Run | Profile | Cost | Diff |
|---|---|---|---|
| A1 | lean | $0.88 | +20 -3 |
| A2 | lean | $0.98 | +24 -3 |
| D1 | ambient | $1.32 | +14 -1 |
| D2 | ambient | $0.85 | +12 -1 |

| Profile | Mean cost | Pass |
|---|---|---|
| A (lean) | $0.93 | 2 of 2 |
| D (ambient) | $1.09 | 2 of 2 |

## Decision

Lean is the default agent profile. Ambient is opt-in.

## Caveats

- **Small n.** Two runs per arm. D1 ($1.32) and D2 ($0.85) differ by more than the gap between the arm means, so the cost difference is not distinguishable from run-to-run spread.
- **Wall time is not comparable.** It was driven by the full-suite runs each agent chose to make, not by the profile. It is not reported here.
- **Patches not merged.** PR #207 fixed the bug on `main`, so none of the four patches were applied. Ambient diffs were smaller (+12 to +14) than lean (+20 to +24); diff size was not judged for quality.
- **Raw results.** The source file `~/bench/hard-fixture-2026-11-19/results.md` was not present on the machine when this page was written; the figures above are as supplied in the task brief.
