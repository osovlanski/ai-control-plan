# Shared live-input prerequisite validation

2026-09-22. Base: `f48ff484f53669da260537885d6d9edf2459db3e`.
Source of extracted behavior: Claude adapter `da1f7d0`.

Historical verdict for the 2026-09-22 branch: **PASS**. No live provider adapter is included.
Fresh restack evidence: [session-input-restack.md](session-input-restack.md).

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`: passed.
- Full suite: core 118, adapters 21, API 964, web 57; 1,160 passed.
- Started `pnpm --filter @agent-plane/api dev` against a fresh temporary
  workspace with `sessionInput.enabled: true`, seeded a running fake session,
  and made authenticated network requests. Capability returned HTTP 200,
  `available: true`, `policy: dispatch`. Submitting a unique client message
  returned HTTP 202, `state: delivered`, `ackLevel: provider-accepted`.
  This validates the real API with the deterministic fake, not provider transport.
- Shared regression tests exercise unknown lookup with both idempotency flags,
  no repeated attempt, later receipt reconciliation, definitive rejection,
  exact target probing, authorization and default-off route absence.
- Core gate tests exercise three-part session identity, missing provider identity,
  default-off grants, restart, revocation during probing, unavailable providers,
  and receipt reads after revocation. The wrapper preserves the adapter's ack ceiling.
- No scheduler semantics or web runtime changed in this slice.
- Secret scan covered staged, unstaged, last-commit and complete slice diffs;
  no credential findings. Provider transcripts are excluded.

The first API smoke attempt exceeded its short startup allowance before the
server listened; a rerun with a bounded 50-second startup allowance reached and
passed every assertion. Local captures are `/tmp/session-input-shared-*.log`.
