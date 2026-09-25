/** Versioned boundary consumed by read-only observability clients such as Cockpit. */
// 1.1 (additive, backward-compatible): Execution Harness durable reads —
// `sessions.read`, `verification.read`, `approvals.read`. Existing 1.0 clients
// keep working; the new capabilities gate the new endpoints only.
// 2.2 (additive, backward-compatible, K18): `decisions.read` for
// `GET /api/decisions` (M16 Decision Service records). Existing clients keep
// working; the new capability gates the new endpoint only.
// `NORMALIZED_EVENT_VERSION` stays 1.0 — a decision record is not a
// normalized event and does not change that contract.
// 2.3 (additive): default-off session input, receipt/capability reads under
// `sessions.read`, and input commands under `commands.write`.
export const CONTROL_PLANE_API_VERSION = "2.3";
export const NORMALIZED_EVENT_VERSION = "1.0";

export const OBSERVABILITY_CAPABILITIES = [
  "tasks.read",
  "events.read",
  "events.stream",
  "routing.read",
  "sessions.read",
  "verification.read",
  "approvals.read",
  "schedules.read",
  // K7 (M12): model identity + catalog reads.
  "models.read",
  // K9 (M14): context observation reads (`GET /api/tasks/:id/context`).
  "context.read",
  // K18 (M16): decision-record reads (`GET /api/decisions`).
  "decisions.read",
] as const;

export const COMMAND_CAPABILITIES = ["commands.write"] as const;

export type ObservabilityCapability = (typeof OBSERVABILITY_CAPABILITIES)[number];
