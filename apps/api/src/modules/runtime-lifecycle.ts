/**
 * Agent runtime v1 read model (docs/contracts/agent-runtime-v1.md, Agent Runtime Registry design
 * §B.3–B.4, PR 3): the runtime catalogue projection and each assistant's lifecycle states.
 *
 * Every state has its own evidence and none implies the next: catalogued (code), configured
 * (config file), installed (`capability_probes` or OpenRouter's live CLI check), authenticated
 * (the adapter's own manifest),
 * conformant (`runtime_conformance`, written from PR 4 on) and enabled (config `enabled` plus the
 * operator overlay). `readiness` folds only the request-independent ones, using the router's own
 * failure texts. It is NOT task eligibility: the router decides that per request, against the
 * constraints listed in `requestDependent`.
 *
 * Pure reads. Nothing here writes, and nothing here reads `runtime_conformance.checks`, adapter
 * options or an environment value.
 */
import type { CapabilityManifest } from "@agent-plane/core";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { INLINE_SECRET } from "../registry-contract.js";
import { probeVersion } from "./capability-probe.js";
import type { AssistantRow, OperatorState } from "./registry.js";
import { conformanceRequiredFor, RUNTIME_CATALOG, runtimeFor } from "./runtime-catalog.js";

/** 1.1 (API 2.11, PR 4): adds the conformance result of `POST /api/assistants/:id/test`. */
export const AGENT_RUNTIME_SCHEMA_VERSION = "1.1";

/** The router's failure text for the operator overlay (router.ts). */
export const OPERATOR_DISABLED_REASON = "disabled by operator";

/** The router's failure text for a runtime that requires conformance evidence it does not have. */
export const conformanceFailureText = (state: Exclude<ConformanceState, "pass">) =>
  `conformance required: ${state} for the observed CLI and descriptor version`;

/**
 * Constraints the router and Prepare evaluate for a specific request (or at routing time), which
 * `readiness` deliberately does not fold in: a ready runtime can still be filtered for a task.
 */
export const REQUEST_DEPENDENT_CONSTRAINTS = Object.freeze([
  "repository-allowlist",
  "filesystem-and-shell",
  "cooldown",
  "quota",
  "workspace-policy",
  "approval-mode",
  "user-override",
  "composition",
] as const);

export interface RuntimeCatalogEntry {
  provider: string;
  label: string;
  transport: "native" | "acp";
  maturity: "verified" | "scaffold";
  harness?: string;
  registryAssistant?: string;
  approvalModes: string[];
  conformanceRequired: boolean;
  docs?: { install?: string; auth?: string };
}

export interface RuntimeCatalogProjection {
  schemaVersion: string;
  descriptorVersion: number;
  runtimes: RuntimeCatalogEntry[];
}

/** The catalogue as data: no `create`, no probe wiring, no options. */
export function runtimeCatalogProjection(): RuntimeCatalogProjection {
  return {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    descriptorVersion: 1,
    runtimes: RUNTIME_CATALOG.map((d) => ({
      provider: d.provider,
      label: d.label,
      transport: d.transport,
      maturity: d.maturity,
      ...(d.harness ? { harness: d.harness } : {}),
      ...(d.registryAssistant ? { registryAssistant: d.registryAssistant } : {}),
      approvalModes: [...d.approvalModes],
      conformanceRequired: d.conformanceRequired,
    })),
  };
}

export type InstalledState = "present" | "missing" | "in-process" | "unknown";
export type AuthState = "ok" | "expired" | "missing" | "unknown";
export type ConformanceState = "not-run" | "pass" | "fail" | "stale";

export interface AssistantLifecycle {
  schemaVersion: string;
  catalogued: boolean;
  configured: boolean;
  installed: { state: InstalledState; version?: string; observedAt?: string };
  auth: { state: AuthState; source?: CapabilityManifest["evidence"]["source"]; observedAt?: string };
  conformance: { required: boolean; state: ConformanceState; descriptorVersion: number; cliVersion?: string; checkedAt?: string };
  enablement: { config: boolean; operator: OperatorState; operatorChangedAt?: string; effective: boolean };
  readiness: { scope: "request-independent"; ready: boolean; reasons: string[] };
  requestDependent: string[];
}

export interface ConformanceRow { cli_version: string; descriptor_version: number; status: "pass" | "fail"; checked_at: string }

/** Everything one lifecycle is derived from. Exported so the derivation is testable without a database. */
export interface LifecycleFacts {
  row: Pick<AssistantRow, "provider" | "enabled" | "operator_state" | "operator_state_at"> & { manifestParsed: CapabilityManifest | null };
  configured: boolean;
  /**
   * The catalogue's answer for the row's provider; absent when this build has no descriptor.
   * `conformanceRequired` is the instance's effective requirement (`conformanceRequiredFor`).
   */
  descriptor?: { descriptorVersion: number; conformanceRequired: boolean };
  /** The last capability probe (`capability_probes`), if one ran. */
  probe?: { version: string; observedAt: string };
  conformance: readonly ConformanceRow[];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A timestamp only when it is one: evidence fields are not trusted to be well-formed. */
const at = (value: unknown): string | undefined => (typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined);
/** A CLI's self-reported version, published only when it is short, printable and carries nothing credential-shaped. */
const safeVersion = (value: string): string | undefined =>
  value.length > 0 && value.length <= 128 && [...value].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f) && !INLINE_SECRET.test(value) ? value : undefined;

const AUTH_STATES: readonly AuthState[] = ["ok", "expired", "missing"];

export function deriveLifecycle(facts: LifecycleFacts): AssistantLifecycle {
  const { row, descriptor, probe, conformance } = facts;
  const manifest = row.manifestParsed;

  let installed: AssistantLifecycle["installed"] = { state: "unknown" };
  // OpenRouter capability probes carry no installation evidence.
  if (probe && row.provider !== "openrouter") {
    const observedAt = at(probe.observedAt);
    const stamp = observedAt ? { observedAt } : {};
    if (probe.version === "unavailable") installed = { state: "missing", ...stamp };
    else if (probe.version === "in-process") installed = { state: "in-process", ...stamp };
    else {
      const version = safeVersion(probe.version);
      installed = { state: "present", ...(version ? { version } : {}), ...stamp };
    }
  }

  const rawAuth = manifest?.core.auth.state;
  const authState: AuthState = rawAuth && (AUTH_STATES as readonly string[]).includes(rawAuth) ? (rawAuth as AuthState) : "unknown";
  const authAt = at(manifest?.evidence.observedAt);
  const auth: AssistantLifecycle["auth"] = {
    state: authState,
    ...(manifest ? { source: manifest.evidence.source } : {}),
    ...(authAt ? { observedAt: authAt } : {}),
  };

  // Evidence counts only for the CLI version observed now AND this descriptor version.
  const descriptorVersion = descriptor?.descriptorVersion ?? 1;
  const cliVersion = probe?.version;
  const match = cliVersion === undefined ? undefined
    : conformance.find((c) => c.cli_version === cliVersion && c.descriptor_version === descriptorVersion);
  const checkedAt = at(match?.checked_at);
  const matchedVersion = match ? safeVersion(match.cli_version) : undefined;
  const conformanceView: AssistantLifecycle["conformance"] = {
    required: descriptor?.conformanceRequired ?? false,
    state: match ? match.status : conformance.length > 0 ? "stale" : "not-run",
    descriptorVersion,
    ...(matchedVersion ? { cliVersion: matchedVersion } : {}),
    ...(checkedAt ? { checkedAt } : {}),
  };

  const operator: OperatorState = row.operator_state === "disabled" ? "disabled" : "none";
  const operatorChangedAt = at(row.operator_state_at);
  const configEnabled = row.enabled === 1;
  const enablement: AssistantLifecycle["enablement"] = {
    config: configEnabled,
    operator,
    ...(operatorChangedAt ? { operatorChangedAt } : {}),
    effective: configEnabled && operator !== "disabled",
  };

  // The router's hard filters that do not depend on the request, in the router's order and
  // with its texts. Conformance gates only an instance that requires it (no shipped descriptor
  // does, owner decision G.3), and then only a `pass` for the observed version pair clears it.
  const reasons: string[] = [];
  if (!configEnabled) reasons.push("disabled in workspace config");
  if (operator === "disabled") reasons.push(OPERATOR_DISABLED_REASON);
  if (!manifest) reasons.push("no capability manifest (sync has not run)");
  else if (manifest.core.auth.state !== "ok") reasons.push(`auth ${manifest.core.auth.state}`);
  if (conformanceView.required && conformanceView.state !== "pass") reasons.push(conformanceFailureText(conformanceView.state));

  return {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    catalogued: descriptor !== undefined,
    configured: facts.configured,
    installed,
    auth,
    conformance: conformanceView,
    enablement,
    readiness: { scope: "request-independent", ready: reasons.length === 0, reasons },
    requestDependent: [...REQUEST_DEPENDENT_CONSTRAINTS],
  };
}

/** Reads the facts for registry rows from the database and derives their lifecycles. */
export class RuntimeLifecycleReader {
  private codexInstallation: Promise<AssistantLifecycle["installed"]> | undefined;

  constructor(private db: Db, private config: ResolvedConfig) {}

  of(row: AssistantRow & { manifestParsed: CapabilityManifest | null }): AssistantLifecycle {
    const descriptor = runtimeFor(row.provider);
    const probeRow = this.db.prepare("SELECT details, observed_at FROM capability_probes WHERE assistant_id = ?").get(row.id) as
      | { details: string; observed_at: string }
      | undefined;
    let probe: LifecycleFacts["probe"];
    if (probeRow) {
      try {
        const version = (JSON.parse(probeRow.details) as { version?: unknown }).version;
        if (typeof version === "string") probe = { version, observedAt: probeRow.observed_at };
      } catch {
        // An unreadable probe row is "no probe", never a guess.
      }
    }
    const conformance = this.db
      .prepare("SELECT cli_version, descriptor_version, status, checked_at FROM runtime_conformance WHERE assistant_id = ?")
      .all(row.id) as ConformanceRow[];
    return deriveLifecycle({
      row,
      configured: Object.prototype.hasOwnProperty.call(this.config.assistants, row.id),
      ...(descriptor ? { descriptor: { descriptorVersion: descriptor.descriptorVersion, conformanceRequired: conformanceRequiredFor(descriptor, this.config.assistants[row.id]?.options ?? {}) } } : {}),
      ...(probe ? { probe } : {}),
      conformance,
    });
  }

  /** Refresh installation evidence for API responses without changing capability or conformance evidence. */
  async withInstallation(lifecycle: AssistantLifecycle, provider: string): Promise<AssistantLifecycle> {
    if (provider !== "openrouter" || !lifecycle.configured) return lifecycle;

    // Concurrent responses, including a list with several OpenRouter assistants, share one host check.
    this.codexInstallation ??= probeVersion("codex").then((version): AssistantLifecycle["installed"] => ({
      state: version === "unavailable" ? "missing" : "present",
      observedAt: new Date().toISOString(),
    })).finally(() => { this.codexInstallation = undefined; });
    return { ...lifecycle, installed: await this.codexInstallation };
  }
}

/**
 * The router's conformance hard filter for one registry row: the failure text when the instance
 * requires conformance (descriptor or, for the fake, its test option) and has no `pass` row for the
 * CLI version the last probe observed and the current descriptor version; `undefined` otherwise.
 * An instance that does not require it is answered without reading the database, so every shipped
 * runtime routes exactly as before (owner decision G.3).
 */
export function conformanceBlock(db: Db, config: ResolvedConfig, row: AssistantRow & { manifestParsed: CapabilityManifest | null }): string | undefined {
  const descriptor = runtimeFor(row.provider);
  if (!descriptor || !conformanceRequiredFor(descriptor, config.assistants[row.id]?.options ?? {})) return undefined;
  const state = new RuntimeLifecycleReader(db, config).of(row).conformance.state;
  return state === "pass" ? undefined : conformanceFailureText(state);
}
