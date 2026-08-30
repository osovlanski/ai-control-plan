/** Versioned boundary consumed by read-only observability clients such as Cockpit. */
export const CONTROL_PLANE_API_VERSION = "1.0";
export const NORMALIZED_EVENT_VERSION = "1.0";

export const OBSERVABILITY_CAPABILITIES = [
  "tasks.read",
  "events.read",
  "events.stream",
  "routing.read",
] as const;

export type ObservabilityCapability = (typeof OBSERVABILITY_CAPABILITIES)[number];
