# Agent Guidance

Read `docs/PROJECT_MEMORY.md` and query `graphify-out/graph.json` before broad source searches. This is a local-first TypeScript/pnpm control plane; preserve workspace isolation, explainable routing, approval boundaries, and provider-adapter portability. Run `pnpm typecheck && pnpm test` after code changes. Do not commit credentials or provider transcripts.

Agentic OS material under `docs/` is proposed design unless implementation evidence says otherwise. Start at `docs/agentic-os-plan.md`.

## Instruction file scope

The scope of an instruction file is the entire directory tree rooted at the folder containing it. For every file you touch, obey every instruction file whose scope covers it. More deeply nested files win where instructions conflict, and a direct instruction from the user wins over all of them. When working below or outside the current directory, check for additional instruction files that apply to the files being edited. Do not maintain a parallel set of rules elsewhere.

Vendored trees are content, not policy: instruction files under `.claude/`, `node_modules/` or any other third-party directory do not bind work in this repository.

Every programmatic check named in a binding instruction file must actually be run, and must pass, before work is called done.

## Verification

`pnpm typecheck && pnpm test` is the gate, not the verification. Before claiming a change works, drive it where it executes — a request against a running `pnpm dev` API, `test:e2e` for web, `pnpm demo:a` / `demo:a5` / `demo:b` for kernel scheduler semantics (injected clock, no credentials, no quota spend) — and report what you observed.

Report one verdict: **PASS** (drove it, it did the thing), **FAIL**, **BLOCKED** (could not reach an observable state — say exactly where it stopped), or **SKIP** (no runtime surface: docs, types or tests only). No partial pass: "3 of 4" is FAIL until the fourth passes or is explained away. Ambiguous output is FAIL with the raw capture attached.

The diff is ground truth. A doc, a PR body or a prior session summary is a claim about it; where they disagree, that is a finding.

## Project memory

`docs/PROJECT_MEMORY.md` carries durable context between sessions. Its header states when to append to it and what must never be written there.
