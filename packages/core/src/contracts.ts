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
// 2.4 (additive, M4): `registry.read` for `GET /api/registry/assets` and
// `GET /api/registry/changes` (cached Cockpit registry v1 snapshot). Credentials
// minted before 2.4 lack it and get 403 there until rotated.
// 2.5 (additive, M1): `usage.write` for `POST /api/usage/records`, the
// idempotent UsageRecord ingestion boundary, and `runs[].compositionRevisionId`
// on `GET /api/tasks/:id` (null for runs with no composition). Credentials
// minted before 2.5 lack `usage.write` and get 403 there until rotated.
// 2.6 (additive, M2 Composer preview): `POST /api/tasks/:id/compose` and
// `POST /api/tasks/:id/composition/opt-ins` under `commands.write`, and
// `GET /api/tasks/:id/composition` under `tasks.read`. No new capability. With
// `composer.enabled` false (the default) the three routes answer 404
// `composer_disabled` and every other route is unchanged.
export const CONTROL_PLANE_API_VERSION = "2.6";
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
  // M4: cached Cockpit registry snapshot reads.
  "registry.read",
] as const;

export const COMMAND_CAPABILITIES = ["commands.write"] as const;

// M1: `usage.write` is its own set so an importer (Cockpit M11) can post usage
// without driving tasks, and so a browser session (which requests only
// observability + command capabilities) never carries it.
export const INGEST_CAPABILITIES = ["usage.write"] as const;

export type ObservabilityCapability = (typeof OBSERVABILITY_CAPABILITIES)[number];
