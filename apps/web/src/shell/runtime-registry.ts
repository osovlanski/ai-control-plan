/**
 * View helpers for the Agents app's runtime registry surface (Agent Runtime Registry PR 5).
 *
 * Presentation only. Readiness, its reasons and conformance state come from the plane as served;
 * nothing here recomputes them. The config snippet is text for the operator to paste: the browser
 * never writes configuration, and no route accepts one.
 */
import type { AssistantLifecycle, RuntimeCatalogEntry } from "../api.js";

/** Catalogue entries with no configured assistant of that provider, in catalogue order. */
export function unconfiguredRuntimes(catalog: readonly RuntimeCatalogEntry[], configuredProviders: readonly string[]): RuntimeCatalogEntry[] {
  const configured = new Set(configuredProviders);
  return catalog.filter((runtime) => !configured.has(runtime.provider));
}

/** An assistant id for the snippet that no configured assistant already uses. */
export function suggestedAssistantId(provider: string, takenIds: readonly string[]): string {
  const taken = new Set(takenIds);
  if (!taken.has(provider)) return provider;
  for (let n = 2; ; n += 1) if (!taken.has(`${provider}-${n}`)) return `${provider}-${n}`;
}

/**
 * The smallest workspace-config entry the plane's config loader accepts for a provider. Options
 * are left to the operator: the catalogue projection carries none by contract, so none are guessed.
 */
export function configSnippet(provider: string, takenIds: readonly string[]): string {
  return [
    "assistants:",
    `  ${suggestedAssistantId(provider, takenIds)}:`,
    `    provider: ${provider}`,
    "    enabled: true",
  ].join("\n");
}

const INSTALLED_TEXT: Record<AssistantLifecycle["installed"]["state"], string> = {
  present: "installed",
  missing: "CLI did not run",
  "in-process": "in-process (no CLI)",
  unknown: "not probed yet",
};

export function installedText(installed: AssistantLifecycle["installed"]): string {
  const base = INSTALLED_TEXT[installed.state] ?? installed.state;
  return installed.state === "present" && installed.version ? `${base} · ${installed.version}` : base;
}

export function authText(auth: AssistantLifecycle["auth"]): string {
  return auth.source ? `${auth.state} · evidence: ${auth.source}` : `${auth.state} · no manifest yet`;
}

const CONFORMANCE_TEXT: Record<AssistantLifecycle["conformance"]["state"], string> = {
  pass: "passed",
  fail: "failed",
  stale: "stale: no result for the CLI and descriptor version observed now",
  "not-run": "not tested",
};

export function conformanceText(conformance: AssistantLifecycle["conformance"]): string {
  const parts = [CONFORMANCE_TEXT[conformance.state] ?? conformance.state];
  if (conformance.cliVersion) parts.push(`for CLI ${conformance.cliVersion}`);
  parts.push(`descriptor v${conformance.descriptorVersion}`);
  parts.push(conformance.required ? "required before routing" : "not required for routing");
  return parts.join(" · ");
}

export function enablementText(enablement: AssistantLifecycle["enablement"]): string {
  const config = enablement.config ? "config enabled" : "config disabled";
  const operator = enablement.operator === "disabled" ? "disabled by operator" : "no operator override";
  return `${config} · ${operator}`;
}

/** Tone for a check or result status, matching the existing ok/warn/danger tokens. */
export function statusTone(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "pass") return "ok";
  if (status === "fail" || status === "unavailable") return "danger";
  if (status === "not-run" || status === "stale") return "warn";
  return "muted";
}
