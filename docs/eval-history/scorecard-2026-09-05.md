# Eval scorecard

Generated: 2026-09-05T08:44:11.242Z  
Commit: `aa7f86a75d5cdc1968277d74be6cc5d733e76c1d`  
Schema: v1  
Config digest: `cd_cd8a0e24`

| scenario | kind | provider | terminal | verification | revisions | tokens | outcome |
|---|---|---|---|---|---|---|---|
| hits-token-cap | fake | - | WAITING_INPUT | - | 0 | 1650 | yielded |
| adapter-error-mid-run | fake | - | WAITING_INPUT | - | 0 | 1650 | failed |
| cross-provider-reroute | fake | - | COMPLETED | true | 1 | 1650 | completed |
| boot-crash-recovery | fake | - | WAITING_INPUT | - | 0 | - | - |
| needs-approval | fake | - | FAILED | - | 0 | 0 | failed |

## Deliberately gated flows

- **compare / race / parallel** — no Execution Harness parity yet (roadmap §3.4); legacy-only until vNext increment 6.
- **provider-resume / cross-provider handoff claim** — the claim protocol is unwired (standing deferral #7).
- **bounded cost caps** — no pricing table to derive cost from tokens yet (standing deferral #3).
- **real-provider approval-gating evidence** (`needs-approval`) — this scorecard's run used the documented FakeAdapter fallback (R8); the real-provider assertion is an area-1 flip precondition.
- **full eval-plan area-1 conformance suite** and **area-2's ≥6/7-over-two-nights bar** — flip preconditions, not increment-3 deliverables (`docs/harness-rollout.md`).
