# Session-input stack normalization

2026-09-23. Reconstructed in isolated worktrees before any remote update.

## Final ancestry

```text
f48ff484f53669da260537885d6d9edf2459db3e  redelivery
└─ 0221ab2f48600dbb2b496e350318974e941feaea  shared live-input contract
   ├─ f7456003fcae84d7c2d93433c0eaa06dfac0c560  Claude adapter / PR #47
   │  └─ 2adca5c2bf499a99359d6b8b5b44735b1a36bcd9  delivery UI / PR #48
   └─ 4c0c6bd6a5df2a5d7f5bc2e4a048a2f5cde8f2a1  Codex transport-only adapter
      └─ spike/codex-session-input-correlated-receipts
```

The Claude/Codex merge base is exactly `0221ab2`. The UI/Claude merge base is
exactly `f745600`. Codex's accepted commit was not rewritten.

## Reconstruction evidence

Claude was built on `0221ab2` as temporary branch
`tmp/session-input-claude-normalized`. Only provider implementation, registration,
tests and the existing Claude documentation section were reapplied.

- Claude adapter files and provider tests match `da1f7d0` byte for byte.
- All nine shared files outside the combined server/documentation files match
  `0221ab2` byte for byte. This includes the service, core interface, opt-in gate,
  shared tests, shared validation document and prerequisite project-memory entry.
- The service and server emit identical JavaScript to `da1f7d0` when transpiled
  with comments removed. Shared comment wording remains the prerequisite's.
- The exact existing Claude documentation section is retained after the shared
  prerequisite section. No provider-specific shared-contract modification was
  needed. No semantic difference was found.

The four UI commits were cherry-picked onto the reconstructed Claude head,
without conflicts. The aggregate original and reconstructed UI patches have the
same stable patch ID: `443fada5c3a6a6e9adfb7a34bf4f074016e118a1`. No UI behavior or
PR scope was added.

## Remote update safety

Before rewriting, both PR heads and commit lists matched the supplied work.
Both remote heads were checked again before pushing. Explicit leases were:

- Claude: `da1f7d09d0705dc209d53ec4025f91bafb04de1d`.
- UI: `f342598a1b8955ef4eb8e49d070e537b1b39df25`.

Both lease-guarded pushes succeeded. PR #47 now targets
`feat/agentic-os-session-input-live-contract`; PR #48 still targets the Claude
branch and contains only its four replayed UI commits. No unconditional force,
new PR, merge, or update to PR #49 was performed.

The unrelated dirty primary checkout was never edited, reset, stashed or
checked out by this work. It advanced independently during the task. The clean
original UI worktree was left detached at its original `f342598` tree before
moving its local branch reference; its files were preserved. Temporary
reconstruction worktrees retain the validated new heads.

## Validation

| Check | Claude reconstruction | UI reconstruction |
|---|---|---|
| Lint, typecheck, build | Pass | Pass |
| Full package suites | Core 118; adapters 34; API 975; web 57 | Core 118; adapters 34; API 981; web 61 |
| Harness, single mode forced on | 975 pass | 981 pass |
| Recovery chaos | 56 pass | 56 pass |
| Chromium | 32 pass | 34 pass |
| Live Claude provider receipt | 1 pass | Inherited identical provider code |
| Secret scan | Clean | Clean |

The credential-gated live test is skipped by the normal package suite and was
also explicitly run on reconstructed Claude. It delivered into the real live
CLI and reconciled the caller UUID from the provider-authored transcript.

The first UI package run timed out at the unchanged 5-second
`model-identity.test.ts` case while validations overlapped. The complete suite
passed on rerun without code, timeout or test changes. Subsequent forced-harness
and browser runs also passed. Generated browser screenshots were restored to
the committed versions; no capture changes entered the restack.

PR #47's remote CI passed on `f745600`:
[Actions run](https://github.com/osovlanski/ai-control-plan/actions/runs/35836516309).
PR #48's remote CI passed on `2adca5c`:
[Actions run](https://github.com/osovlanski/ai-control-plan/actions/runs/35837445959). CI runs on pull requests and pushes to `main`; the standalone spike
has no covering push trigger and no PR was opened for it.

Merge order: redelivery, shared prerequisite, then the sibling Claude and Codex
adapters; UI after Claude; receipt research after the Codex adapter. Combining
both provider branches may require the normal additive wiring merge in registry
and server files; this normalization does not merge their implementations.
