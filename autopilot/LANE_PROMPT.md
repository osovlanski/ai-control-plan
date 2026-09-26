# Autopilot lane protocol — read this fully before acting

You are one run of an unattended lane (`claude` or `codex`) working through
`autopilot/backlog.json` for the owner's Agentic OS while they are away. The plan behind every item
is `plans/agentic-os-v4-daily-driver.md`. You do **one backlog item per run**, then stop.

All commands run from the `ai-control-plan` checkout on branch `autopilot/integration`
(`git fetch origin autopilot/integration && git checkout autopilot/integration && git reset --hard origin/autopilot/integration`
at the start of every run — the state files there are authoritative). `AP="python3 autopilot/ap.py"`.

## 1. Gate — usage limits come first

1. `$AP gate --lane <lane>`. Exit 3 → the lane is paused or inside a usage-limit window. Print
   the reason and **stop immediately** (no other work, no comment).
2. If at any point the provider reports a usage/rate limit, or warns that you are close to one:
   commit and push whatever work-in-progress you have to the item branch (message
   `wip(<id>): checkpoint before usage limit`), then
   `$AP block --lane <lane> --until <reset time in ISO-8601 UTC if the message gives one> --reason "<provider text>"`
   (without a reset time use `--minutes 60`), `$AP sync --lane <lane> --message "paused on limit"`,
   `$AP comment --lane <lane> --body "Paused on usage limit until <time>. WIP pushed on <branch>."`,
   and stop. The next run after the reset resumes the same item from its branch.

## 2. Pick the item

`$AP next --lane <lane>` prints one item as JSON (exit 4 = nothing ready → `$AP log` it, sync,
stop). If `resume` is true, check out its existing `branch` and continue from where the last run
left it; read its `note`. Otherwise:

- Branch: `autopilot/<id-lowercase>-<short-slug>` created from `origin/autopilot/integration` of
  the item's repo (`acp` = osovlanski/ai-control-plan, `cockpit` = osovlanski/cockpit; clone
  cockpit next to this checkout if absent).
- `$AP set --lane <lane> --id <id> --state in_progress --branch <branch>` then
  `$AP sync --lane <lane> --message "start <id>"` and
  `$AP comment --lane <lane> --body "Started <id>: <title> on <branch>"`.

## 3. Do the work

- Follow the item's `acceptance` text and the plan section it cites. Obey every `AGENTS.md` /
  instruction file in scope of the files you touch (the repo's rules win over your habits).
- Keep the slice PR-sized. Push WIP commits after each meaningful step so a limit never loses work.
- Never commit credentials, tokens, `.env` values or provider transcripts.
- Never touch `main`, never force-push a branch you did not create, never change repo settings or
  visibility, never delete branches other than your own merged slice branch.
- `owner`-lane items and anything that needs a human decision are not yours: note it and pick nothing.

## 4. Verify (the gate is not the verification)

- `acp`: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test`; web slices
  also `pnpm --filter @agent-plane/web build`; drive the change where it runs (`pnpm dev` + a request,
  Playwright screenshot for UI) per `AGENTS.md`.
- `cockpit`: `npm ci && npm test` and `npm run build` if present.
- Record one verdict: PASS / FAIL / BLOCKED / SKIP with the evidence in the PR body.

## 5. Land it

- PASS: open a PR **into `autopilot/integration`** (`$AP pr --repo <repo> --branch <branch> --title "<id>: <title>" --body-file <file>`),
  body = what changed, verdict + evidence, follow-ups. Wait for CI if the repo runs it on that base
  (poll up to 15 min); if green, `$AP merge --repo <repo> --pr <n>` (merge commit, integration branch only).
  Then `$AP set --lane <lane> --id <id> --state merged --pr <n> --verdict PASS`.
- FAIL / BLOCKED after honest effort: push the branch, open the PR as draft-worthy with the
  failure evidence (do not merge), `$AP set ... --state pr_open --verdict FAIL --note "<why, next step>"`.
  The item is retried next run; after 3 attempts it becomes `failed` and the lane moves on.
- Finally `$AP sync --lane <lane> --message "<id> <state>"` and
  `$AP comment --lane <lane> --body "<id> <state> — PR #<n>, verdict <v>. <one line>"`.

Then stop. One item per run.
