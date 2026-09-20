# Agent Guidance — apps/web

Scoped to `@agent-plane/web`. The repository root `AGENTS.md` still applies.

- The operator console is `OrbitalBoard.tsx` plus `src/board/` (`CommandBar`, `Inspector`, `OrbitalField`, `TaskRegister`, `readouts.tsx`). `useBoard()` in `OrbitalBoard.tsx` is the single read of kernel state; do not add a store, and do not recompute kernel state client-side. `orbital.ts` and `board/execution.ts` derive layout and view state only.
- `pnpm --filter @agent-plane/web test:e2e` (chromium) is the acceptance surface. Visual regression is the Playwright `visual` project and has no npm script on this branch: build the package first, then `pnpm --filter @agent-plane/web exec playwright test --project=visual`. Update visual baselines only for an intentionally visual change, and say so in the change description.
- `demo:a` / `demo:a5` / `demo:b` are deterministic: injected clock, no credentials, no quota spend. They are the runtime evidence for scheduler-facing UI work.
- Scope e2e locators to a container. Ambiguous top-level text matches are the recurring failure in this package.
