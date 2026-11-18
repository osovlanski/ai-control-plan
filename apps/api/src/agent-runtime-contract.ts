/**
 * Reference implementation of the agent runtime v1 contract (docs/contracts/agent-runtime-v1.md).
 * The JSON Schemas under contracts/agent-runtime/v1 are the wire authority; this module adds the
 * rules a schema cannot state (unique providers, `effective` and `ready` consistent with the
 * states they fold) and the version policy. The fixtures and the API's own responses are run
 * through it by the tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ContractResult } from "./registry-contract.js";
import {
  AGENT_RUNTIME_SCHEMA_VERSION, OPERATOR_DISABLED_REASON,
  type AssistantLifecycle, type RuntimeCatalogProjection,
} from "./modules/runtime-lifecycle.js";

// ajv-formats is CJS; under bundler resolution its default lands on `.default`.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => void;

export { AGENT_RUNTIME_SCHEMA_VERSION };
export const AGENT_RUNTIME_CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/agent-runtime/v1");
const BASE = "https://agent-plane.local/contracts/agent-runtime/v1/";

export interface OperatorStateChange {
  schemaVersion: string;
  assistantId: string;
  operatorState: "none" | "disabled";
  changed: boolean;
  lifecycle: AssistantLifecycle;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
for (const name of ["catalog.schema.json", "assistant-lifecycle.schema.json", "operator-state-change.schema.json"]) {
  ajv.addSchema(JSON.parse(readFileSync(join(AGENT_RUNTIME_CONTRACT_DIR, name), "utf8")) as object);
}
const catalogSchema = ajv.getSchema(`${BASE}catalog.schema.json`)!;
const lifecycleSchema = ajv.getSchema(`${BASE}assistant-lifecycle.schema.json`)!;
const changeSchema = ajv.getSchema(`${BASE}operator-state-change.schema.json`)!;

/** Same major, and no minor newer than the reader's: the objects are closed, so an older reader cannot honour a newer field. */
export function isReadableVersion(served: unknown, supported = AGENT_RUNTIME_SCHEMA_VERSION): boolean {
  if (typeof served !== "string") return false;
  const s = /^(\d+)\.(\d+)$/.exec(served);
  const r = /^(\d+)\.(\d+)$/.exec(supported);
  return !!s && !!r && s[1] === r[1] && Number(s[2]) <= Number(r[2]);
}

const schemaErrors = (validate: typeof catalogSchema, prefix = "") =>
  (validate.errors ?? []).map((e) => `${prefix}${e.instancePath || "/"} ${e.message ?? "invalid"}`);

function versionGate(body: unknown, supported: string): string[] {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  return isReadableVersion(version, supported) ? [] : [`unsupported schemaVersion ${JSON.stringify(version)}; this reader supports ${supported}`];
}

function lifecycleRuleErrors(l: AssistantLifecycle, at = ""): string[] {
  const errors: string[] = [];
  const effective = l.enablement.config && l.enablement.operator !== "disabled";
  if (l.enablement.effective !== effective) errors.push(`${at}/enablement/effective must be config AND operator is not disabled`);
  if (l.readiness.ready && !l.enablement.effective) errors.push(`${at}/readiness/ready cannot be true while the assistant is not effectively enabled`);
  if (l.readiness.ready && l.auth.state !== "ok") errors.push(`${at}/readiness/ready cannot be true while auth is ${l.auth.state}`);
  if (l.enablement.operator === "disabled" && !l.readiness.reasons.includes(OPERATOR_DISABLED_REASON)) {
    errors.push(`${at}/readiness/reasons must name "${OPERATOR_DISABLED_REASON}" while the operator overlay is disabled`);
  }
  if (l.installed.version !== undefined && l.installed.state !== "present") errors.push(`${at}/installed/version is only reported for an installed CLI`);
  if (l.conformance.state === "not-run" || l.conformance.state === "stale") {
    if (l.conformance.checkedAt !== undefined || l.conformance.cliVersion !== undefined) errors.push(`${at}/conformance carries a check time or version only for a matching row`);
  }
  return errors;
}

export function validateRuntimeCatalog(body: unknown, supported = AGENT_RUNTIME_SCHEMA_VERSION): ContractResult<RuntimeCatalogProjection> {
  const gate = versionGate(body, supported);
  if (gate.length) return { ok: false, errors: gate };
  if (!catalogSchema(body)) return { ok: false, errors: schemaErrors(catalogSchema) };
  const catalog = body as RuntimeCatalogProjection;
  const seen = new Set<string>();
  const errors: string[] = [];
  catalog.runtimes.forEach((r, i) => {
    if (seen.has(r.provider)) errors.push(`/runtimes/${i}/provider ${r.provider} is listed twice`);
    seen.add(r.provider);
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: catalog };
}

export function validateAssistantLifecycle(body: unknown, supported = AGENT_RUNTIME_SCHEMA_VERSION): ContractResult<AssistantLifecycle> {
  const gate = versionGate(body, supported);
  if (gate.length) return { ok: false, errors: gate };
  if (!lifecycleSchema(body)) return { ok: false, errors: schemaErrors(lifecycleSchema) };
  const errors = lifecycleRuleErrors(body as AssistantLifecycle);
  return errors.length ? { ok: false, errors } : { ok: true, value: body as AssistantLifecycle };
}

export function validateOperatorStateChange(body: unknown, supported = AGENT_RUNTIME_SCHEMA_VERSION): ContractResult<OperatorStateChange> {
  const gate = [...versionGate(body, supported), ...versionGate((body as { lifecycle?: unknown } | null)?.lifecycle ?? null, supported).map((e) => `/lifecycle ${e}`)];
  if (gate.length) return { ok: false, errors: gate };
  if (!changeSchema(body)) return { ok: false, errors: schemaErrors(changeSchema) };
  const change = body as OperatorStateChange;
  const errors = lifecycleRuleErrors(change.lifecycle, "/lifecycle");
  if (change.operatorState !== change.lifecycle.enablement.operator) errors.push("/operatorState disagrees with /lifecycle/enablement/operator");
  return errors.length ? { ok: false, errors } : { ok: true, value: change };
}
