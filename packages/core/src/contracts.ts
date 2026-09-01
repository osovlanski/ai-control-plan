/** Versioned boundary consumed by read-only observability clients such as Cockpit. */
// 1.1 (additive, backward-compatible): Execution Harness durable reads —
// `sessions.read`, `verification.read`, `approvals.read`. Existing 1.0 clients
// keep working; the new capabilities gate the new endpoints only.
export const CONTROL_PLANE_API_VERSION = "1.1";
export const NORMALIZED_EVENT_VERSION = "1.0";

export const OBSERVABILITY_CAPABILITIES = [
  "tasks.read",
  "events.read",
  "events.stream",
  "routing.read",
  "sessions.read",
  "verification.read",
  "approvals.read",
] as const;

export type ObservabilityCapability = (typeof OBSERVABILITY_CAPABILITIES)[number];
