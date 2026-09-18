# Conversational shell acceptance captures

Historical first-slice captures. See the [fresh preservation review](../shell-review/README.md)
for the complete destination/state set and the current acceptance record.

Captured from the production web bundle against isolated real Fastify/SQLite
APIs and deterministic FakeAdapters. These are test workspaces, not live provider
activity. Provider names, tasks and approvals are test inputs; state is supplied
by the real backend. No credentials, traces or provider transcripts are included.

Reference inspected: `/home/ubuntu/workspace/reference-images/agentic-os-target.png`.

| Capture | Evidence |
| --- | --- |
| [Desktop](overview-desktop.png) | Seven-item rail, primary composer, real task partitions and selected mission |
| [Laptop](overview-laptop.png) | Two-column workspace and orbit hierarchy |
| [Tablet](overview-tablet.png) | Stacked workspace and reachable navigation |
| [Mobile](overview-mobile.png) | Wrapping navigation, full content without horizontal overflow |
| [Reduced motion](overview-reduced-motion.png) | Same information with continuous movement disabled |
| [1280×800 model evidence](model-evidence-1280.png) | ACTUAL/SHADOW key remains visible |
| [Inline routing](inline-routing-preview.png) | Durable preview with no provider execution; explicit start |
| [Selected mission](mission-conversation.png) | Recorded messages and explicit free-text limitation |
| [Approval](durable-approval.png) | Pending persisted request and shell Approve/Deny controls |

The visual and Demo B suites completed on 2026-09-18 (6/6); shell captures are
from the final seven-test shell pass on 2026-09-17. Acceptance is documented in
[the canonical shell design](../../agentic-os-ui-v3.md#validation-record--2026-09-1718).
