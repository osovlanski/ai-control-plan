# Session-input restack

## Remote baseline and owner decision

2026-09-24. Classification completed before branch creation or cherry-picks.

- `origin/main`: `d151c54f6b586e807e83f692e142875ee0b29abc`.
- PR #50: `0221ab2f48600dbb2b496e350318974e941feaea` (18 commits).
- PR #47: `f7456003fcae84d7c2d93433c0eaa06dfac0c560`; PR #51: `4c0c6bd6a5df2a5d7f5bc2e4a048a2f5cde8f2a1`.
- Updated PR #54 read at `96bd5257f5494886ee8165a878ba56927f3816a3`, based on K19h. It has no migrations and remains untouched, as do all M16/K19h-i branches.
- Owner decision: main Shell survives; core on main, composer later. #48 and the correlated-receipts spike remain untouched.
- Remote main already contains migrations 025–027. Allocate **028_session_input.sql** and **029_session_input_commands.sql**.
- Local graph queried directly (graphify CLI unavailable); no session-input/Shell symbols found, so source and Git evidence used.

Classes: (a) content already on main; (b) needed session-input core; (c) conflicting/deferred Shell/UI; (d) mixed.

| Source SHA | Class | Evidence / scope | Action |
| --- | --- | --- | --- |
| `faf82f81ec30acf40f17e825cffaf8a0d3260efa` | (a) | Conversational-shell ownership is already incorporated in main; later main documentation wins. | Skip |
| `2857938f1c4153980a31f3d2b15119a0d02a739e` | (a) | Seven application routes/workspaces are already incorporated; main includes subsequent Shell refinements. | Skip |
| `5e92d7e725b76bb324ddce7cc7b6f1a8917ddd48` | (a) | Mission intake and durable approvals are already incorporated in main. | Skip |
| `f88f3dc413cc27709d47bdc627750052be4152b0` | (a) | Conversational-shell tests are incorporated; main includes subsequent fixes. | Skip |
| `103b8033f44bff1f7bf07234bb31ca50c24ba744` | (a) | Acceptance record and captures are incorporated; main has the later acceptance record. | Skip |
| `64bd08d2ba5ab9e65572e1031ef4141b2c53bc11` | (a) | Shell truth fixes and captures are incorporated in main. | Skip |
| `b49425d75d7a64b655853fe4ca3a9365fdb4b287` | (a) | Deployment and Sirius documents match main exactly; Shell document has subsequent acceptance additions. | Skip |
| `879723e710ef3e4eb41bad7e8d7e5d0793c811e2` | (a) | The entire contract file at this commit is byte-identical to main. Requested contract base is already present. | Retain main file; no duplicate/empty cherry-pick |
| `cd0b8103eecb713ecff077f3c4ebc700eeef9f52` | (a) | All 31 changed files at this commit are byte-identical to main, including StandaloneShell.tsx and its CSS. Remote evidence supersedes the independent-implementation claim. | Skip |
| `a7401a31a1a868db794790bf51fc91c80b177b4e` | (a) | Both acceptance documents are byte-identical to main. | Skip |
| `d05691951b25f55e901e53f12579595421c1a967` | (b) | Durable ledger, API/service, fake adapter and provider-neutral types; no Shell dependency. | Cherry-pick; ledger migration 028 |
| `95e35a30096c9b35b58ebb1a3236c1ad603f88c2` | (b) | API, database, restart and ambiguous-delivery tests. | Cherry-pick |
| `348269c782a1eb953680d3d4400d716fdef45e56` | (c) | Composer, web API client, Shell wiring/CSS and browser proof belong to the separate composer port. | Skip entirely |
| `4bb431ebcce723a379892d8c632a66e1f42a9700` | (d) | Contract/status documents plus a standalone-Shell status edit; implementation record also claims composer delivery. | Take contract/implementation docs; correct backend-only scope; omit Shell doc hunk |
| `558a90326ed5a15da38b602e3dd6ada3ba4136b8` | (d) | Core retry/cancel, commands migration/tests plus web client/composer changes. Clean file boundary. | Take apps/api and packages/core only; commands migration 029 |
| `3f13093add1bb3cbf79427b997b0071900b76a30` | (b) | Scheduler-owned redelivery, SSE and API regression tests; independent of Shell. | Cherry-pick |
| `f48ff484f53669da260537885d6d9edf2459db3e` | (b) | Retry/cancel and redelivery contract/status additions. | Cherry-pick |
| `0221ab2f48600dbb2b496e350318974e941feaea` | (b) | Provider-neutral live contract, session opt-in and API tests; core-only. | Cherry-pick; preserve main memory and additive API version |

## Reconciliation boundaries

The conflict report is about the final branch trees, not proof that the original Shell commit differs: `git diff cd0b810 origin/main -- <all 31 paths>` is empty. Later composer edits cause the Shell divergence. Main’s contract equals `879723e` byte-for-byte; retain it and apply subsequent status/contract additions in place. No duplicate contract is needed.

The two mixed commits split at file boundaries without a core dependency on the composer. No content from `348269c` is required by the backend. Preserve main’s entire web tree. Preserve default-off configuration and the fake-only default adapter resolver.

## Validation

Pending implementation and gates. Historical validation in imported documents is not fresh evidence for this restack.
