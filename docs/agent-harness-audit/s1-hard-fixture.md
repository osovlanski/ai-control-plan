# S1 hard fixture: handoff leaves the task RUNNING

Run 2026-11-19. Fixture: a refused handoff, after its source drained, leaves the task RUNNING with nothing running (the 6 `it.fails` regressions from `0fbcb9a`). Opus 5.5, effort high, 2 reps per arm. A is the lean profile; D is ambient (`~/.claude` extras on).

## Results

| Run | Cost | Wall | Turns | Cache-create / cache-read / output | Diff | RSS |
|---|---|---|---|---|---|---|
| A1 | $0.88 | 47 min | 7 | 3.8K / 365K / 3.0K | +20 -3 | 733 MB |
| A2 | $0.98 | 15 min | 9 | 5.9K / 563K / 3.1K | +24 -3 | 741 MB |
| D1 | $1.32 | 38 min | 10 | 7.0K / 612K / 3.3K | +14 -1 | 726 MB |
| D2 | $0.85 | 5 min | 25 | 62K / 1,127K / 6.6K | +12 -1 | 737 MB |

All 4 passed: the target test flipped, the other `it.fails` untouched, typecheck and lint clean.

- **Cost:** A averaged $0.93 per run, D $1.09. The gap is within the run-to-run spread (on the small fixture, `s1-results.md`, it was 2.8x).
- **Correctness:** pass rate and diff size are equal at n=2.
- **Wall time:** driven by whether a session ran the full suite, not by the arm.
- **RSS:** about 730 MB in both arms.

## Decision

Lean profile by default, ambient extras opt-in. The case rests on cost and startup load, not on quality.

D2 (the smallest patch) was chosen and passed the full gate on `a08ff69`.

## Caveats

- n=2 per arm: no statistical claim; cost ranges overlap.
- Wall time reflects full-suite runs, so it says nothing about the arms.
- Hard-task quality difference between arms is not shown, not ruled out.
