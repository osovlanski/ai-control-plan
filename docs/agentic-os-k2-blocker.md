# K2 architectural blocker — successor identity before routing

Status: resolved. The two-phase protocol below is implemented and K2 acceptance
criteria 13–18 are covered by tests. K3 has not started. The conflict was found
during the K2 implementation preflight on `feat/agentic-os-k1-durable-dispatch`;
this report is kept as the decision record for why wake does not claim.

The normative wake protocol in `agentic-os-kernel-services.md` §4.2.3 requires
the checkpoint-anchored Harness successor request to be built and inserted via
`handoff.claim` inside the transaction consuming the wait (step 5). It then
requires routing and persistence of the accepted routing decision outside that
transaction (step 6). Acceptance criterion 17 explicitly requires this claim in
the wake transaction.

Those requirements conflict with the existing immutable request contract:

- `packages/core/src/execution.ts`, `ExecutionRequest`, requires the selected
  `assistantId` and `routingDecisionRef` when a request is accepted.
- `packages/core/src/fingerprint.ts`, `canonicalRequestProjection`, fingerprints
  both fields. They cannot be filled in later under the same request identity.
- `apps/api/src/modules/harness/session-store.ts`, `recordRequest`, rejects a
  repeated identity with a different fingerprint.
- `apps/api/src/modules/harness/handoff.ts`, `claim`, requires the actual
  successor request row, checks its envelope/task/prompt identity, and atomically
  claims the envelope. A dispatch reservation alone cannot satisfy this API.

In particular, a wake with no eligible candidate cannot build a valid successor
at step 5. Using the predecessor assistant or a placeholder would freeze an
execution choice before revalidation; changing it after routing would violate
request immutability. K1 avoids this conflict because it has no checkpoint claim
and builds the fresh request only after routing.

## Accepted resolution — two-phase durable dispatch

The canonical contract is corrected in `agentic-os-kernel-services.md` §4.2.3.
Wake reserves ownership without resolving execution. Routing then atomically persists
and links one decision to that dispatch. Materialization subsequently persists the
complete immutable request with `executionRequestId = dispatchId`, and co-commits
the Harness envelope claim. Only then may start be attempted.

Recovery routes only if no decision was committed; after a linked decision it reuses
that decision; after materialization it reuses the same request identity and resolved fields, re-rendering its prompt from immutable provenance and verifying the fingerprint. Rendered prompts remain unpersisted (execution-harness §10). Cancellation checks
apply at every write/start boundary. The canonical recovery table defines A–G.

Rejected alternatives:

- Placeholder/predecessor assistant followed by request mutation violates fingerprint
  identity and I-S1.
- Routing inside wake (the original proposed resolution in this report) needlessly
  couples reservation to execution selection and changes the existing K1 seam.
- Claiming an envelope without a complete request weakens the existing claim protocol.
- A second successor retry identity is unnecessary: a new wake already has a new
  dispatch, while retries of the same dispatch must reuse its immutable successor.

Exact affected canonical sections: §4.2.2 wake transition side effects; §4.2.3
wake/routing/materialization protocol, identity, cancellation and boot recovery;
§5 K1 acceptance 3's step reference and K2 acceptance 17's claim ordering and
boundary regressions. Deferral #7 still requires atomic request/claim, start-intent/
ambiguity and first-ack/consumption; none requires claiming before routing.
The plan/vNext references delegate to these sections and need no competing protocol.

Implementation status: implemented. `Scheduler.start` routes and links one decision
per dispatch in a single transaction; `Orchestrator.startTask` materializes the
immutable request under `executionRequestId = dispatchId` and, on the Harness
checkpoint path, co-commits `HandoffService.bindSuccessor` → `claim`; `start` marks
`start_attempted` from `beforeStart` before any provider call. Boot recovery covers
A–G. K3 excluded.

## Baseline validation (2026-09-06)

- `pnpm typecheck`: passed.
- `pnpm test`: 559 passed (core 70, adapters 8, API 475, web 6).
- `pnpm test:harness-on`: 475 passed; also run with
  `AGENT_PLANE_HARNESS_SINGLE_MODE=1`: 475 passed.
- `pnpm test:recovery-chaos`: 56 passed.
- `AGENT_PLANE_EVAL=0 pnpm eval`: five fake scenarios passed; three real-provider
  scenarios skipped. The real-provider completion gate remains unmet.

These results validated the K1 baseline before K2 changed any code.

## K2 validation (2026-09-06)

- `pnpm typecheck` (including `@agent-plane/eval`): passed.
- `pnpm lint`: passed.
- `pnpm test`: 584 passed (core 70, adapters 8, API 500, web 6).
- `pnpm test:harness-on`: 500 passed; also with
  `AGENT_PLANE_HARNESS_SINGLE_MODE=1`: 500 passed.
- `pnpm test:recovery-chaos`: 56 passed.
- `AGENT_PLANE_EVAL=0 pnpm eval`: 7/7 fake scenarios passed, including
  `quota-wait-and-resume` on both the harness and legacy paths; three
  real-provider scenarios skipped. The real-provider completion gate is a
  standing increment-3 deferral and is unchanged by K2.
