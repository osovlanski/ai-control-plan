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

/** The collapsed Agents row's standing chip. Words and tone come from the served lifecycle only. */
export function agentStanding(lifecycle: AssistantLifecycle | undefined, configEnabled: boolean): { label: string; tone: "ok" | "warn" | "danger" | "muted" } {
  if (!lifecycle) return configEnabled ? { label: "Enabled", tone: "muted" } : { label: "Disabled", tone: "warn" };
  if (!lifecycle.enablement.effective) return { label: "Disabled", tone: "warn" };
  return lifecycle.readiness.ready ? { label: "Ready", tone: "ok" } : { label: "Not ready", tone: "danger" };
}

const CONFORMANCE_SHORT: Record<AssistantLifecycle["conformance"]["state"], string> = {
  pass: "test passed",
  fail: "test failed",
  stale: "test stale",
  "not-run": "not tested",
};

/** The lifecycle facts the full list shows below it, in the same words. Enablement is the chip and the served reasons. */
export function lifecycleDigest(lifecycle: AssistantLifecycle): string {
  return [
    installedText(lifecycle.installed),
    CONFORMANCE_SHORT[lifecycle.conformance.state] ?? lifecycle.conformance.state,
  ].join(" · ");
}

/** The header count, e.g. "3 agents · 2 ready · 1 not ready". Counts the standings the rows show. */
export function agentTally(standings: readonly string[]): string {
  const count = (label: string) => standings.filter((s) => s === label).length;
  const parts = [`${standings.length} ${standings.length === 1 ? "agent" : "agents"}`];
  for (const [label, text] of [["Ready", "ready"], ["Not ready", "not ready"], ["Disabled", "disabled"], ["Enabled", "enabled"]] as const) {
    if (count(label)) parts.push(`${count(label)} ${text}`);
  }
  return parts.join(" · ");
}
