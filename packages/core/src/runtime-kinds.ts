/**
 * The runtime kinds: one data-only row per workspace `provider` the plane can construct an adapter
 * for (Agent Runtime Registry design, §B.2 and PR 2). Core holds the facts that the composer and
 * config validation need and that must not depend on adapter classes; `apps/api`'s runtime
 * catalogue extends each row with the adapter constructor and probe wiring.
 *
 * Data only: no I/O, no registration, nothing taken from configuration. A runtime is added by a
 * reviewed PR that adds a row here and a descriptor in `apps/api/src/modules/runtime-catalog.ts`.
 *
 * `PROVIDER_HARNESS` (harness-model.ts), `REGISTRY_ASSISTANT` (assets.ts) and the API's
 * `HARNESS_APPROVAL_MODES` (composer/ports.ts) are derived from this table, so a fact lives once.
 */
import type { ApprovalMode, Harness } from "./composer/types.js";

/** The value type a known `assistants.<id>.options` key must have when present. */
export type RuntimeOptionType =
  | "string"
  | "boolean"
  | { readonly oneOf: readonly string[] }
  /** A list of `{ id: string, displayName?: string }` (the fake's model selectors). */
  | "model-list";

export interface RuntimeKind {
  /** Workspace config `assistants.<id>.provider`. Matches `/^[a-z][a-z0-9-]{0,31}$/`. */
  readonly provider: string;
  /** Composition vocabulary. Absent: routable, never composed (the fake's harness is a per-instance test option). */
  readonly harness?: Harness;
  /** Registry v1 `compatibility.assistants` id for the harness, where one exists. */
  readonly registryAssistant?: string;
  /** Approval modes the adapter enforces; it refuses the rest before a process starts. */
  readonly approvalModes: readonly ApprovalMode[];
  /**
   * Known option keys and their types, checked at config load. Unknown keys are accepted
   * unchanged (they always were), so an existing config keeps loading.
   */
  readonly options: Readonly<Record<string, RuntimeOptionType>>;
}

const ALL_MODES: readonly ApprovalMode[] = ["auto-approve", "prompt-on-escalation", "read-only"];
const kind = (k: RuntimeKind): RuntimeKind =>
  Object.freeze({ ...k, approvalModes: Object.freeze([...k.approvalModes]), options: Object.freeze({ ...k.options }) });

/** In the order the unknown-provider error has always listed them. */
export const RUNTIME_KINDS: readonly RuntimeKind[] = Object.freeze([
  kind({
    provider: "anthropic", harness: "claude-code", registryAssistant: "claude", approvalModes: ALL_MODES,
    // Read by the idle quota probe (K3). `usageEndpoint` is accepted only as the fixed endpoint; that
    // value check stays in quota-probe.ts.
    options: { credentialsPath: "string", usageEndpoint: "string" },
  }),
  kind({ provider: "openai", harness: "codex", registryAssistant: "codex", approvalModes: ["auto-approve", "read-only"], options: { appServerInput: "boolean" } }),
  kind({
    provider: "openrouter", harness: "codex", registryAssistant: "codex", approvalModes: ["auto-approve", "read-only"],
    options: {
      model: "string", baseUrl: "string", apiKeyEnv: "string",
      reasoningEffort: { oneOf: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
    },
  }),
  kind({ provider: "cursor", harness: "cursor", registryAssistant: "cursor", approvalModes: ["auto-approve"], options: { command: "string", model: "string" } }),
  // Tools run remotely and the adapter enforces no mode; claiming one would be false.
  kind({ provider: "bedrock", harness: "bedrock", approvalModes: [], options: { agentRuntimeArn: "string", qualifier: "string", region: "string" } }),
  // Test-only: accepts every mode and enforces none. `harness` is only type-checked here: the
  // adapter's constructor keeps refusing an unknown value with its own message.
  kind({ provider: "fake", approvalModes: ALL_MODES, options: { harness: "string", agentUser: "boolean", models: "model-list", sessionRefAfterStart: "boolean" } }),
]);

/** The row for a workspace `provider`, or `undefined` when this build has none (prototype keys included). */
export function runtimeKindFor(provider: string): RuntimeKind | undefined {
  return RUNTIME_KINDS.find((k) => k.provider === provider);
}

/** Catalogued providers, in table order. */
export function runtimeProviders(): string[] {
  return RUNTIME_KINDS.map((k) => k.provider);
}

/**
 * One value per harness, in first-seen table order, that every row with that harness agrees on.
 * Two rows that disagree (say openai and openrouter on approval modes) are a table error, thrown at
 * module load rather than resolved silently.
 */
export function perHarness<T>(pick: (k: RuntimeKind) => T, same: (a: T, b: T) => boolean = Object.is): Readonly<Record<Harness, T>> {
  const out = {} as Record<Harness, T>;
  for (const k of RUNTIME_KINDS) {
    if (!k.harness) continue;
    const value = pick(k);
    if (Object.prototype.hasOwnProperty.call(out, k.harness)) {
      if (!same(out[k.harness], value)) throw new Error(`RUNTIME_KINDS: providers with harness ${k.harness} disagree`);
      continue;
    }
    out[k.harness] = value;
  }
  return Object.freeze(out);
}

const sameModes = (a: readonly ApprovalMode[], b: readonly ApprovalMode[]) => a.length === b.length && a.every((m, i) => m === b[i]);

/** Harness → the approval modes its adapters enforce, derived from `RUNTIME_KINDS`. */
export const HARNESS_APPROVAL_MODES_BY_KIND: Readonly<Record<Harness, readonly ApprovalMode[]>> = perHarness((k) => k.approvalModes, sameModes);

/**
 * Problems with one configured assistant's provider and options, each prefixed with its config
 * path. Empty when the provider is catalogued and every known option has its declared type.
 */
export function runtimeConfigProblems(id: string, provider: unknown, options: unknown): string[] {
  const at = `assistants.${id}`;
  if (typeof provider !== "string") return [`${at} must have a provider`];
  const k = runtimeKindFor(provider);
  if (!k) return [`${at}.provider ${JSON.stringify(provider)} is not supported (supported: ${runtimeProviders().join(", ")})`];
  if (options === undefined || options === null) return [];
  if (typeof options !== "object" || Array.isArray(options)) return [`${at}.options must be a mapping`];
  const problems: string[] = [];
  for (const [key, type] of Object.entries(k.options)) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) continue;
    const value = (options as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const problem = optionProblem(type, value);
    if (problem) problems.push(`${at}.options.${key} ${problem} for provider ${provider}, got ${JSON.stringify(value)}`);
  }
  return problems;
}

function optionProblem(type: RuntimeOptionType, value: unknown): string | undefined {
  if (type === "string") return typeof value === "string" ? undefined : "must be a string";
  if (type === "boolean") return typeof value === "boolean" ? undefined : "must be a boolean";
  if (type === "model-list") {
    const ok = Array.isArray(value) && value.every((m) =>
      m !== null && typeof m === "object" && typeof (m as { id?: unknown }).id === "string"
      && ((m as { displayName?: unknown }).displayName === undefined || typeof (m as { displayName?: unknown }).displayName === "string"));
    return ok ? undefined : "must be a list of { id, displayName? } strings";
  }
  return typeof value === "string" && type.oneOf.includes(value) ? undefined : `must be one of ${type.oneOf.join(" | ")}`;
}
