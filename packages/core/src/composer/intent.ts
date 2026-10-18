/**
 * Stage 1, intent classification (plans/m2-composer.md §2 stage 1).
 *
 * `kind` is the stored classifier v1 label, never recomputed, so a composition sits in the same
 * cohort as telemetry (K20). A task stored before migration 031 has no label; v1 labels it at read
 * time exactly as telemetry does. `domains` come from a frozen marker table read at the base
 * commit. `complexity` is `M` by rule `complexity-unmeasured`: K20 records no complexity, and
 * inventing a signal here would make one up. `risk` is decided by named rules.
 */
import type { IntentKind } from "../composition-types.js";
import { classifyTaskV1 } from "../task-classifier.js";
import { overrideWhy, sortedUnique, type RawCandidate, type RawStage } from "./explain.js";
import type { ComposedIntent, ComposerInputs, IntentRisk, RepoSignals } from "./types.js";

/** Frozen v1 marker table: a marker file's presence alone names these domains. */
const MARKER_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  "Cargo.toml": ["rust"],
  "go.mod": ["go"],
  "package.json": ["node"],
  "pnpm-workspace.yaml": ["pnpm-workspace"],
  "pyproject.toml": ["python"],
  "tsconfig.json": ["typescript"],
};

/** Frozen v1 table: a package.json dependency (any dependency field) names this domain. */
const PACKAGE_DEPENDENCY_DOMAINS: Readonly<Record<string, string>> = {
  "@angular/core": "angular",
  "@playwright/test": "playwright",
  "better-sqlite3": "sqlite",
  express: "express",
  fastify: "fastify",
  jest: "jest",
  next: "nextjs",
  prisma: "prisma",
  react: "react",
  svelte: "svelte",
  typescript: "typescript",
  vite: "vite",
  vitest: "vitest",
  vue: "vue",
};
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * Frozen v1 high-risk vocabulary, in this order. Each pattern is linear: no unbounded quantifier
 * is followed by anything that can make it backtrack.
 */
const HIGH_RISK_VOCABULARY: ReadonlyArray<readonly [term: string, pattern: RegExp]> = [
  ["deploy", /\bdeploy(?:s|ed|ing|ments?)?\b/],
  ["production", /\bproduction\b/],
  ["migrate data", /\bmigrat(?:e|es|ed|ing|ion)\s+(?:the\s+)?data\b|\bdata\s+migrations?\b/],
  ["delete", /\bdelet(?:e|es|ed|ing|ion)\b/],
  ["drop", /\bdrop(?:s|ped|ping)?\b/],
  ["force-push", /\bforce[- ]?push(?:es|ed|ing)?\b/],
  ["credential", /\bcredentials?\b/],
  ["secret", /\bsecrets?\b/],
];

const LOW_RISK_KINDS: ReadonlySet<IntentKind> = new Set(["review", "research"]);
const RISK_ORDER: Readonly<Record<IntentRisk, number>> = { low: 0, normal: 1, high: 2 };
export const INTENT_KINDS: readonly IntentKind[] = ["coding", "content", "general", "ops", "planning", "research", "review"];
const DOMAIN_NAME = /^[a-z0-9][a-z0-9.+_-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

export interface IntentStageResult {
  stage: RawStage;
  /** The intent with the override applied: what later stages read. */
  intent: ComposedIntent;
  /** The intent the pipeline computed before any override (stage 5 uses it to refuse a loosening). */
  computed: ComposedIntent;
  refused?: string;
}

interface DomainSignals { domains: Map<string, string[]>; notes: string[] }

function readDomains(signals: RepoSignals): DomainSignals {
  const domains = new Map<string, string[]>();
  const notes: string[] = [];
  if (signals.status !== "ok") return { domains, notes };
  const add = (domain: string, evidence: string) => domains.set(domain, [...(domains.get(domain) ?? []), evidence]);
  for (const file of [...signals.files].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))) {
    const markerDomains = MARKER_DOMAINS[file.relPath];
    if (!markerDomains) continue;
    for (const domain of markerDomains) add(domain, `marker ${file.relPath}`);
    if (file.relPath !== "package.json") continue;
    let manifest: unknown;
    try { manifest = JSON.parse(file.content); } catch { manifest = undefined; }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      notes.push(`package.json ${file.truncated ? "truncated at the read cap" : "is not a JSON object"}; dependencies not read`);
      continue;
    }
    const names = new Set<string>();
    for (const field of DEPENDENCY_FIELDS) {
      const deps = (manifest as Record<string, unknown>)[field];
      if (deps && typeof deps === "object" && !Array.isArray(deps)) for (const name of Object.keys(deps)) names.add(name);
    }
    for (const name of Object.keys(PACKAGE_DEPENDENCY_DOMAINS).sort()) {
      if (names.has(name)) add(PACKAGE_DEPENDENCY_DOMAINS[name]!, `marker package.json: dependency ${name}`);
    }
  }
  return { domains, notes };
}

function decideRisk(kind: IntentKind, text: string): { risk: IntentRisk; evidence: string[]; rule: string } {
  const matched = HIGH_RISK_VOCABULARY.filter(([, pattern]) => pattern.test(text)).map(([term]) => term);
  // High risk wins over a low-risk kind: a review that names a deploy is still a deploy.
  if (matched.length) return { risk: "high", rule: "explicit-high-risk", evidence: matched.map((term) => `rule explicit-high-risk: matched '${term}'`) };
  if (LOW_RISK_KINDS.has(kind)) return { risk: "low", rule: "kind-low-risk", evidence: [`rule kind-low-risk: kind ${kind}`] };
  return { risk: "normal", rule: "default-normal", evidence: ["rule default-normal: no high-risk term and kind is not review or research"] };
}

const refs = (intent: ComposedIntent) => [
  `kind:${intent.kind}`, ...intent.domains.map((d) => `domain:${d}`), `complexity:${intent.complexity}`, `risk:${intent.risk}`,
];

export function intentStage(inputs: ComposerInputs): IntentStageResult {
  const { task, repoSignals } = inputs;
  const kind: IntentKind = task.storedKind ?? classifyTaskV1(task.goal);
  const kindEvidence = task.storedKind ? "stored classifier v1 label" : "classifier v1 at read time (task predates stored labels)";
  const { domains, notes } = readDomains(repoSignals);
  const text = [task.goal, ...task.constraints].join("\n").toLowerCase();
  const risk = decideRisk(kind, text);
  const computed: ComposedIntent = { kind, domains: sortedUnique(domains.keys()), complexity: "M", risk: risk.risk };

  const candidates: RawCandidate[] = [
    { ref: `kind:${kind}`, evidence: [kindEvidence] },
    ...[...domains].map(([domain, evidence]) => ({ ref: `domain:${domain}`, evidence })),
    { ref: "complexity:M", evidence: ["rule complexity-unmeasured: K20 records no complexity"] },
    { ref: `risk:${risk.risk}`, evidence: risk.evidence },
  ];

  const signalsWhy = repoSignals.status === "ok"
    ? `repository signals at ${COMMIT.test(repoSignals.baseCommit) ? repoSignals.baseCommit : "the base commit"}`
    : `no repository signals: ${repoSignals.reason}`;
  const why = [
    `kind ${kind} (${kindEvidence})`,
    `risk ${risk.risk} (rule ${risk.rule})`,
    "complexity M (rule complexity-unmeasured)",
    `domains ${computed.domains.length ? computed.domains.join(", ") : "none"} (${signalsWhy})`,
    ...notes,
  ].join("; ");

  const given = inputs.overrides?.intent;
  // An override with no field is no override.
  const override = given && (given.kind !== undefined || given.domains !== undefined || given.risk !== undefined) ? given : undefined;
  if (!override) return { stage: { stage: "intent", candidates, filters: [], chosen: refs(computed), why }, intent: computed, computed };

  const refuse = (detail: string): IntentStageResult => ({
    stage: { stage: "intent", candidates, filters: [], chosen: [], why: `override refused: ${detail}` },
    intent: computed, computed, refused: detail,
  });
  if (override.kind !== undefined && !INTENT_KINDS.includes(override.kind)) return refuse("intent kind is not a composition intent kind");
  if (override.risk !== undefined && RISK_ORDER[override.risk] === undefined) return refuse("intent risk is not low, normal or high");
  if (override.domains && override.domains.some((d) => !DOMAIN_NAME.test(d))) return refuse("an intent domain is not a domain name");

  const intent: ComposedIntent = {
    kind: override.kind ?? computed.kind,
    domains: override.domains ? sortedUnique(override.domains) : computed.domains,
    complexity: computed.complexity,
    risk: override.risk ?? computed.risk,
  };
  const from = refs(computed);
  const to = refs(intent);
  const known = new Set(candidates.map((c) => c.ref));
  for (const ref of to) if (!known.has(ref)) candidates.push({ ref, evidence: ["operator override"] });
  return {
    stage: { stage: "intent", candidates, filters: [], chosen: to, why: overrideWhy(from, why), override: { from, to } },
    intent, computed,
  };
}
