/**
 * M16 Decision Service — provider registry and fallback chain (plan
 * `plans/jev-decision-service-plan.md` §5, K17), plus the K18 decision-record
 * write path.
 *
 * K19d registers `ModelDecisionProvider` (`decision-model.ts`) under `model`,
 * and the Jev slice `TypeSafeDecisionProvider` (`decision-typesafe.ts`) under
 * `typesafe`. Neither has a hot-path role: the tool gate reads rules and
 * floors only (K19i).
 */
import { createHash } from "node:crypto";
import type { ClassifierIntent, DecisionOutcome, DecisionProvider, DecisionRequest, DecisionSite, ToolGateVerdict } from "@agent-plane/core";
import { RulesDecisionProvider, TASK_CLASSIFIER_BATTERY, TOOL_GATE_JUDGED_KEYS, taskClassifierAnswers } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import { ModelDecisionProvider } from "./decision-model.js";
import type { ResolvedDecisionsConfig } from "../config.js";
import { DEFAULT_TYPESAFE_MODEL, TYPESAFE_ROUTES, TypeSafeDecisionProvider } from "./decision-typesafe.js";
import { SecretBroker } from "./harness/secret-broker.js";

export interface DecisionServiceConfig {
  /** The first provider to try. The chain still falls back toward "rules". */
  provider: DecisionProvider["id"];
  /**
   * The TypeSafe key's reference NAME (`decisions.typesafeApiKeyRef`). Naming
   * it is the workspace's egress opt-in (I-D7, config.ts); with none, Jev has
   * no key and is never called.
   */
  typesafeApiKeyRef?: string;
  /** Which endpoint serves Jev (`decisions.typesafeRoute`); default `direct`. */
  typesafeRoute?: "direct" | "openrouter";
  /** The pinned Jev model (`decisions.typesafeModel`); default `DEFAULT_TYPESAFE_MODEL`. */
  typesafeModel?: string;
  /** Consecutive failures before a provider's circuit opens. */
  circuitBreakerThreshold?: number;
  /** How long an open circuit stays open before the next attempt is allowed. */
  circuitBreakerCooldownMs?: number;
}

/**
 * Per-call context a `decide()` caller supplies for the K18 record — never
 * part of the single-flight key (§5 K17), since two callers asking the exact
 * same question about the exact same state may still be different sessions.
 * Passing this is what turns a `decide()` call into a recorded one; a caller
 * that omits it (every K17 test) gets no row, matching K17's "no behaviour
 * change" done-when.
 */
export interface DecisionRecordContext {
  taskId?: string;
  sessionId?: string;
  /** K18 wires shadow-only call sites; `applied` has no producer until K19. */
  mode: "shadow" | "applied";
  /**
   * K19b: `BuiltDecisionState.truncated` from the `DecisionStateBuilder` that
   * produced `req.state` (§4.4). Omitted means "this caller did not build a
   * bounded state", which is recorded as `false` — the honest reading, since
   * a state that was never bounded was never truncated either.
   */
  stateTruncated?: boolean;
  /** K19c: what the tool gate did with this decision (migration 026). Absent on every other site. */
  gate?: ToolGateVerdict & { hook: "pre-exec" | "post-start"; tier: "preventive" | "audit" };
  /** K20: the rule behind each answer, keyed by answer key (migration 031). Absent on every other site. */
  rules?: Record<string, string>;
}

/**
 * Row shape for `GET /api/decisions` (K18) — the answers and the question-set
 * hash, never `DecisionRequest.state` (see the migration's header comment).
 */
export interface DecisionRecordRow {
  id: number;
  taskId: string | null;
  sessionId: string | null;
  site: DecisionSite;
  provider: DecisionOutcome["provider"];
  modelReported: string | null;
  questionSetHash: string;
  answers: DecisionOutcome["answers"];
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  mode: "shadow" | "applied";
  degradedReason: string | null;
  stateTruncated: boolean;
  gateOutcome: ToolGateVerdict["outcome"] | null;
  gateReason: string | null;
  gateHook: "pre-exec" | "post-start" | null;
  gateTier: "preventive" | "audit" | null;
  rules: Record<string, string> | null;
  createdAt: string;
}

/** Stable across calls with the same questions — lets a reader spot drift without storing the question text on every row. */
function questionSetHash(questions: DecisionRequest["questions"]): string {
  return createHash("sha256").update(JSON.stringify(questions)).digest("hex");
}

/** The one writer of `decision_records` (append-only — no UPDATE, no DELETE, no upsert). */
export function insertDecisionRecord(
  db: Db,
  req: DecisionRequest,
  outcome: DecisionOutcome,
  ctx: DecisionRecordContext,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO decision_records
       (task_id, session_id, site, provider, model_reported, question_set_hash, answers_json, latency_ms, input_tokens, output_tokens, mode, degraded_reason, state_truncated, created_at,
        gate_outcome, gate_reason, gate_hook, gate_tier, rules_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ctx.taskId ?? null,
    ctx.sessionId ?? null,
    req.site,
    outcome.provider,
    outcome.modelReported ?? null,
    questionSetHash(req.questions),
    JSON.stringify(outcome.answers),
    outcome.latencyMs,
    // The provider's own accounting (K19d), or NULL when it made no metered
    // call — a fabricated count would not be honest (I-D5's discipline).
    outcome.usage?.inputTokens ?? null,
    outcome.usage?.outputTokens ?? null,
    ctx.mode,
    outcome.degraded?.reason ?? null,
    // §4.4 deterministic truncation, as the builder reported it — a truncated
    // state is a named condition on the record, never a silent one.
    ctx.stateTruncated ? 1 : 0,
    createdAt,
    ctx.gate?.outcome ?? null,
    ctx.gate?.reason ?? null,
    ctx.gate?.hook ?? null,
    ctx.gate?.tier ?? null,
    ctx.rules ? JSON.stringify(ctx.rules) : null,
  );
}

/**
 * K20: the shadow `task-classifier` row for a task just created — v1 (what
 * routing reads) and v2 side by side, with the rule behind each answer.
 * Synchronous and rules-only on purpose: it never goes through the provider
 * chain, so a workspace configured with a judge cannot reach one at intake
 * (K19i: no judge on the hot path). Nothing reads this row to route.
 */
export function recordTaskClassification(db: Db, taskId: string, intent: ClassifierIntent, createdAt: string): void {
  const startedMs = Date.now();
  const { answers, rules } = taskClassifierAnswers(intent);
  insertDecisionRecord(
    db,
    // `state` is never stored (025's invariant); the record keeps the answers and the question-set hash.
    { site: "task-classifier", state: {}, questions: TASK_CLASSIFIER_BATTERY, budgetMs: 0 },
    { answers, provider: "rules", latencyMs: Date.now() - startedMs },
    { taskId, mode: "shadow", rules },
    createdAt,
  );
}

/** Read side for `GET /api/decisions`. Most recent first, optionally scoped to one site. */
export function listDecisions(db: Db, opts: { site?: DecisionSite; limit?: number } = {}): DecisionRecordRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = (
    opts.site
      ? db
          .prepare(
            `SELECT * FROM decision_records WHERE site = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(opts.site, limit)
      : db.prepare(`SELECT * FROM decision_records ORDER BY id DESC LIMIT ?`).all(limit)
  ) as Array<{
    id: number;
    task_id: string | null;
    session_id: string | null;
    site: DecisionSite;
    provider: DecisionOutcome["provider"];
    model_reported: string | null;
    question_set_hash: string;
    answers_json: string;
    latency_ms: number;
    input_tokens: number | null;
    output_tokens: number | null;
    mode: "shadow" | "applied";
    degraded_reason: string | null;
    state_truncated: number;
    created_at: string;
    gate_outcome: ToolGateVerdict["outcome"] | null;
    gate_reason: string | null;
    gate_hook: "pre-exec" | "post-start" | null;
    gate_tier: "preventive" | "audit" | null;
    rules_json: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    sessionId: r.session_id,
    site: r.site,
    provider: r.provider,
    modelReported: r.model_reported,
    questionSetHash: r.question_set_hash,
    answers: JSON.parse(r.answers_json) as DecisionOutcome["answers"],
    latencyMs: r.latency_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    mode: r.mode,
    degradedReason: r.degraded_reason,
    stateTruncated: r.state_truncated === 1,
    gateOutcome: r.gate_outcome,
    gateReason: r.gate_reason,
    gateHook: r.gate_hook,
    gateTier: r.gate_tier,
    rules: r.rules_json ? (JSON.parse(r.rules_json) as Record<string, string>) : null,
    createdAt: r.created_at,
  }));
}

export interface ToolGatePromptRate {
  sessionId: string;
  taskId: string | null;
  mode: "shadow" | "applied";
  evaluations: number;
  /** In `shadow`, prompts that WOULD have been raised. */
  prompts: number;
  promptRate: number;
}

/**
 * K19c / §8: prompt rate per run, derived from the gate rows themselves (DB is
 * truth — no counter to drift). A gate that prompts on everything gets
 * switched off; this is the number K22 charts to catch that before it happens.
 * Every evaluation counts, pre-exec and post-start alike: `gate_hook` on the
 * rows is there for a reader who wants them split.
 */
export function toolGatePromptRates(db: Db, opts: { limit?: number } = {}): ToolGatePromptRate[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = db
    .prepare(
      `SELECT session_id, MAX(task_id) AS task_id, mode, COUNT(*) AS evaluations,
              SUM(CASE WHEN gate_outcome = 'prompt' THEN 1 ELSE 0 END) AS prompts
         FROM decision_records
        WHERE site = 'tool-gate' AND gate_outcome IS NOT NULL AND session_id IS NOT NULL
        GROUP BY session_id, mode
        ORDER BY MAX(id) DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ session_id: string; task_id: string | null; mode: "shadow" | "applied"; evaluations: number; prompts: number }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    taskId: r.task_id,
    mode: r.mode,
    evaluations: r.evaluations,
    prompts: r.prompts,
    promptRate: r.prompts / r.evaluations,
  }));
}

/**
 * The tool gate's shadow-soak query for §7.1(1), (2) and (7). `plans/progress.md`
 * quotes it verbatim, so a change here is a change there. It reads only shadow
 * `tool-gate` rows written at or after `:since`, the soak's T0, from sessions of
 * one adapter (`assistants.provider`) under one approval mode (the execution
 * request's policy): the pair being judged for activation (plan §7.4).
 */
export const SOAK_SQL = `SELECT d.session_id, d.gate_hook, d.gate_outcome, d.gate_reason, d.created_at
  FROM decision_records d
  JOIN runs r ON r.id = d.session_id
  JOIN assistants a ON a.id = r.assistant_id
  JOIN execution_requests e ON e.id = r.execution_request_id
 WHERE d.site = 'tool-gate' AND d.mode = 'shadow' AND d.created_at >= :since
   AND a.provider = :adapter AND json_extract(e.policy, '$.approval.mode') = :approvalMode
 ORDER BY d.session_id, d.id`;

type SoakVerdict = "PASS" | "FAIL" | "INSUFFICIENT";

export interface SoakCheck {
  since: string;
  now: string;
  readThrough: string | null;
  adapter: string;
  approvalMode: string;
  volume: {
    rows: number;
    calls: number;
    /** The volume §7.4 counts: distinct calls that had a pre-exec hook. */
    preExecCalls: number;
    /** `decisions.sites.tool-gate.soakMinPreExecCalls`; null when the owner has set none. */
    minPreExecCalls: number | null;
    first: string | null;
    last: string | null;
    days: number;
    verdict: SoakVerdict;
    pass: boolean;
  };
  disagreements: { n: number; unread: number; verdict: SoakVerdict; pass: boolean };
  promptRate: {
    byHook: Array<{ hook: string | null; calls: number; prompts: number; rate: number | null }>;
    byReason: Array<{ hook: string | null; reason: string | null; prompts: number }>;
    verdict: SoakVerdict;
    pass: boolean;
  };
}

interface SoakRow {
  session_id: string;
  gate_hook: "pre-exec" | "post-start" | null;
  gate_outcome: string | null;
  gate_reason: string | null;
  created_at: string;
}

/** One tool call: its `post-start` row, its `pre-exec` row, or both. */
type SoakCall = { post?: SoakRow; pre?: SoakRow };

/**
 * A Claude call that needs permission writes a `post-start` row (the
 * `tool_use` block) and then a `pre-exec` row (`canUseTool`), so rows are not
 * calls. Within a session, a `pre-exec` row is the same call as the latest
 * earlier `post-start` row not already paired. Rows are in session, id order.
 */
// ponytail: rows carry no tool identity, so pairing is by order. Two calls
// emitted together pair crosswise, which keeps the counts right. An adapter
// that raises an approval with no tool.started, after an unpaired one in the
// same session, would lose one call; record the tool-use id if one ever does.
function soakCalls(rows: readonly SoakRow[]): SoakCall[] {
  const calls: SoakCall[] = [];
  let session: string | undefined;
  let open: SoakCall[] = [];
  for (const row of rows) {
    if (row.session_id !== session) [session, open] = [row.session_id, []];
    if (row.gate_hook === "pre-exec") {
      const call = open.pop();
      if (call) call.pre = row;
      else calls.push({ pre: row });
    } else {
      const call = { post: row };
      calls.push(call);
      open.push(call);
    }
  }
  return calls;
}

const RULES_ALLOWED = new Set(["auto-approve", "prompt"]);

/**
 * §7.1(1): the distinct `pre-exec` calls for the pair reach the owner's
 * minimum, at ≥ 14 days since T0, or reach 500. With no minimum set the
 * verdict is INSUFFICIENT whatever the count: a soak never passes on the
 * clock (plan §7.4).
 * §7.1(2): (1) holds and every prompting call is at or before `readThrough`,
 * the time through which the operator's reading is recorded.
 * §7.1(7): (1) holds and the reading covers the last row, so the rate read is
 * the rate measured. A reading is recorded by hand in `plans/progress.md`;
 * nothing here writes one. Timestamps are ISO strings, compared as such.
 * (2) and (7) read INSUFFICIENT while (1) does.
 */
export function toolGateSoakCheck(
  db: Db,
  opts: { since: string; now: string; readThrough?: string; adapter: string; approvalMode: string; minPreExecCalls?: number },
): SoakCheck {
  const { since, adapter, approvalMode } = opts;
  const readThrough = opts.readThrough ?? null;
  const min = opts.minPreExecCalls ?? null;
  const rows = db.prepare(SOAK_SQL).all({ since, adapter, approvalMode }) as SoakRow[];
  const calls = soakCalls(rows);
  const days = (Date.parse(opts.now) - Date.parse(since)) / 86_400_000;
  const preExecCalls = calls.filter((c) => c.pre).length;
  const volumePass = min !== null && (preExecCalls >= 500 || (days >= 14 && preExecCalls >= min));
  const stamps = rows.map((r) => r.created_at).sort();
  const last = stamps.at(-1) ?? null;
  const verdict = (pass: boolean): SoakVerdict => (!volumePass ? "INSUFFICIENT" : pass ? "PASS" : "FAIL");

  // A call prompts when either of its rows does; it is read once, at its last row.
  const prompting = calls.filter((c) => c.pre?.gate_outcome === "prompt" || c.post?.gate_outcome === "prompt");
  const unread = prompting.filter((c) => readThrough === null || (c.pre ?? c.post)!.created_at > readThrough).length;

  const byHook = (["post-start", "pre-exec"] as const).flatMap((hook) => {
    const hookRows = calls.map((c) => (hook === "pre-exec" ? c.pre : c.post)).filter((r): r is SoakRow => !!r && RULES_ALLOWED.has(r.gate_outcome ?? ""));
    if (!hookRows.length) return [];
    const prompts = hookRows.filter((r) => r.gate_outcome === "prompt").length;
    return [{ hook, calls: hookRows.length, prompts, rate: prompts / hookRows.length }];
  });
  const reasons = new Map<string, { hook: string | null; reason: string | null; prompts: number }>();
  for (const c of prompting) {
    const r = c.pre?.gate_outcome === "prompt" ? c.pre : c.post!;
    const key = `${r.gate_hook}\u0000${r.gate_reason}`;
    const e = reasons.get(key) ?? { hook: r.gate_hook, reason: r.gate_reason, prompts: 0 };
    e.prompts += 1;
    reasons.set(key, e);
  }
  const byReason = [...reasons.values()].sort(
    (a, b) => b.prompts - a.prompts || String(a.hook).localeCompare(String(b.hook)) || String(a.reason).localeCompare(String(b.reason)),
  );

  const disPass = volumePass && unread === 0;
  const ratePass = volumePass && readThrough !== null && last !== null && last <= readThrough;
  return {
    since,
    now: opts.now,
    readThrough,
    adapter,
    approvalMode,
    volume: {
      rows: rows.length,
      calls: calls.length,
      preExecCalls,
      minPreExecCalls: min,
      first: stamps[0] ?? null,
      last,
      days,
      verdict: volumePass ? "PASS" : "INSUFFICIENT",
      pass: volumePass,
    },
    disagreements: { n: prompting.length, unread, verdict: verdict(disPass), pass: disPass },
    promptRate: { byHook, byReason, verdict: verdict(ratePass), pass: ratePass },
  };
}

/**
 * Every `DecisionProvider` this build has BEYOND `RulesDecisionProvider`,
 * which `DecisionService` always registers itself (I-D6).
 *
 * Registering is not selecting: the chain starts at `config.provider`, whose
 * default is `rules`, so a workspace that has not chosen a judge never reaches
 * one and emits no byte (I-D7). The §7.2 suites drive the chain from the top
 * and so measure a judge whenever its credential is present.
 *
 * - `model` (K19d): the workspace's own Anthropic account key, read at the
 *   call boundary on every decision, never stored on the provider.
 * - `typesafe` (Jev): the key named by `typesafeApiKeyRef`, resolved per call
 *   through a `SecretBroker` scoped to that one reference and disposed at
 *   once. No reference, no key: the provider is registered and unreachable.
 */
export function decisionProviders(config: DecisionServiceConfig): DecisionProvider[] {
  const ref = config.typesafeApiKeyRef;
  return [
    new ModelDecisionProvider({ apiKey: () => process.env.ANTHROPIC_API_KEY }),
    new TypeSafeDecisionProvider({
      apiKey: ref ? () => brokeredSecret(ref) : () => undefined,
      ...(ref ? { keyRef: ref } : {}),
      baseUrl: TYPESAFE_ROUTES[config.typesafeRoute ?? "direct"],
      model: config.typesafeModel ?? DEFAULT_TYPESAFE_MODEL,
    }),
  ];
}

/**
 * The floor discovery job's service (K19l), the one process that sends
 * decision state to a vendor. The judge is `decisions.discoveryProvider`
 * (default `model`, Haiku, as before), and I-D7 is checked HERE, where the
 * egress happens, not only at config load: `typesafe` sends tool calls to
 * TypeSafe (and OpenRouter), so it needs the workspace's opt-in, a named
 * `typesafeApiKeyRef` in the personal workspace. Without it this throws and
 * nothing is sent.
 */
export function discoveryDecisionService(
  decisions: Pick<ResolvedDecisionsConfig, "discoveryProvider" | "typesafeApiKeyRef" | "typesafeRoute" | "typesafeModel">,
  workspace: string,
): DecisionService {
  const provider = decisions.discoveryProvider;
  if (provider === "typesafe") {
    if (!decisions.typesafeApiKeyRef) {
      throw new Error("decisions.discoveryProvider: typesafe REFUSED — this workspace has not opted in to TypeSafe egress (no decisions.typesafeApiKeyRef, I-D7). Nothing was sent.");
    }
    if (workspace !== "personal") {
      throw new Error(`decisions.discoveryProvider: typesafe REFUSED — TypeSafe egress is opt-in for the personal workspace only (I-D7); workspace "${workspace}" may not. Nothing was sent.`);
    }
  }
  const config: DecisionServiceConfig = {
    provider,
    ...(provider === "typesafe"
      ? { typesafeApiKeyRef: decisions.typesafeApiKeyRef, typesafeRoute: decisions.typesafeRoute, typesafeModel: decisions.typesafeModel }
      : {}),
  };
  return new DecisionService(config, decisionProviders(config));
}

/** One reference, resolved from the session env (§9.1) through a broker scoped to it alone. */
function brokeredSecret(ref: string): string | undefined {
  const broker = new SecretBroker((r) => process.env[r], [ref]);
  try {
    return broker.resolve([ref])[ref];
  } catch {
    return undefined; // the error names the reference; the caller reports it as "did not resolve"
  } finally {
    broker.dispose();
  }
}

const FALLBACK_ORDER: DecisionProvider["id"][] = ["typesafe", "model", "rules"];

interface CircuitState {
  consecutiveFailures: number;
  openUntilMs?: number;
}

/**
 * Provider registry + per-request timeout + single-flight + circuit breaker +
 * fallback chain `typesafe → model → rules`. `RulesDecisionProvider` is
 * always registered and cannot be overridden by `extraProviders` (I-D6): no
 * config, build or test may leave the chain without a reachable,
 * vendor-free provider.
 */
export class DecisionService {
  private providers = new Map<DecisionProvider["id"], DecisionProvider>();
  private circuits = new Map<DecisionProvider["id"], CircuitState>();
  private inFlight = new Map<string, Promise<DecisionOutcome>>();

  constructor(
    private config: DecisionServiceConfig,
    extraProviders: DecisionProvider[] = [],
    private clock: () => number = Date.now,
    /** Present in production wiring (composition.ts); absent in every K17 unit test, which never records. */
    private db?: Db,
  ) {
    for (const p of extraProviders) this.providers.set(p.id, p);
    this.providers.set("rules", new RulesDecisionProvider());
    // I-D2, degrade LOUD (K19i): a configured provider this build does not
    // register used to fall through to rules with a `degraded` note on every
    // call, and the gate prompted on each one. That made every §7.2
    // gate-outcome figure through K19g true by construction, and a workspace
    // following §7.4's example (`provider: typesafe`) prompt on every tool
    // call. It is a configuration error, so it stops the process at startup.
    if (!this.providers.has(config.provider)) {
      throw new Error(
        `decisions.provider: ${JSON.stringify(config.provider)} is not registered in this build ` +
          `(registered: ${[...this.providers.keys()].join(", ")}). Configure one of those, or remove ` +
          `decisions.provider to use rules.`,
      );
    }
  }

  /**
   * K18: a record is written for EVERY call to `decide()`, at THIS boundary —
   * not inside `decideUncached` or a provider. Single-flight collapses the
   * WORK for identical concurrent requests, but each caller still reaches
   * this line on its own await, so N deduped callers still produce N rows,
   * each carrying its own caller-supplied `record` context (task/session).
   * Omitting `record` (every K17 test, and any call with no DB wired) skips
   * the write entirely rather than writing a contextless row.
   */
  async decide(req: DecisionRequest, record?: DecisionRecordContext): Promise<DecisionOutcome> {
    const key = singleFlightKey(req);
    let promise = this.inFlight.get(key);
    if (!promise) {
      promise = this.decideUncached(req).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, promise);
    }
    const outcome = await promise;
    if (this.db && record) {
      insertDecisionRecord(this.db, req, outcome, record, new Date(this.clock()).toISOString());
    }
    return outcome;
  }

  /**
   * I-D8 (§5 K19): `applied` is refused at a site unless a provider in the
   * CONFIGURED chain declares it judges every judged key there. With rules
   * alone every judged answer is absent, absence resolves to prompt, and an
   * applied gate would prompt on every rules-allowed call — the fastest way to
   * get it switched off. The refusal never silently downgrades: the caller gets
   * the reason and must say it out loud.
   */
  activation(site: "tool-gate", requested: "shadow" | "applied"): { mode: "shadow" | "applied"; refusal?: string } {
    if (requested === "shadow") return { mode: "shadow" };
    const chain = FALLBACK_ORDER.slice(Math.max(FALLBACK_ORDER.indexOf(this.config.provider), 0));
    const judge = chain.some((id) => {
      // An unreachable judge (no credential) judges nothing, whatever it could.
      const d = this.providers.get(id)?.describe();
      const judged = (d?.reachable && d.judges?.[site]) || [];
      return TOOL_GATE_JUDGED_KEYS.every((k) => judged.includes(k));
    });
    if (judge) return { mode: "applied" };
    return {
      mode: "shadow",
      refusal:
        `decisions.sites.${site}.mode: applied REFUSED — no provider in the configured chain ` +
        `(${chain.join(" → ")}) judges ${TOOL_GATE_JUDGED_KEYS.join(", ")}. With rules alone those answers ` +
        `are absent, absence resolves to prompt, and every rules-allowed tool call would prompt the operator ` +
        `(I-D8). The site stays in shadow.`,
    };
  }

  private async decideUncached(req: DecisionRequest): Promise<DecisionOutcome> {
    const startIdx = FALLBACK_ORDER.indexOf(this.config.provider);
    const chain = FALLBACK_ORDER.slice(startIdx < 0 ? 0 : startIdx);
    // The FIRST non-rules failure is kept — it names the primary provider's own
    // reason (e.g. a real "401 bad key"), which is what an operator needs to
    // act on. A later fallback being unregistered is a structural fact, not the
    // thing that actually went wrong, and must not overwrite it.
    let degraded: DecisionOutcome["degraded"];

    for (const id of chain) {
      const provider = this.providers.get(id);
      if (!provider) {
        if (id !== "rules") degraded ??= { from: id, reason: `provider "${id}" is not registered in this build` };
        continue;
      }
      const circuit = this.circuits.get(id);
      if (circuit?.openUntilMs !== undefined && this.clock() < circuit.openUntilMs) {
        if (id !== "rules") degraded ??= { from: id, reason: `provider "${id}" circuit is open` };
        continue;
      }
      try {
        const outcome = await withTimeout(provider.decide(req), req.budgetMs, id);
        this.recordSuccess(id);
        return degraded ? { ...outcome, degraded } : outcome;
      } catch (err) {
        this.recordFailure(id);
        if (id !== "rules") {
          degraded ??= { from: id, reason: err instanceof Error ? err.message : String(err) };
        } else {
          // Rules is the terminal fallback and is expected to never throw
          // (I-D6). If it does, that is a bug in the rules mapping, not a
          // degraded-provider condition — fail loud rather than swallow it.
          throw err;
        }
      }
    }
    throw new Error("DecisionService: no provider answered, including rules");
  }

  private recordSuccess(id: DecisionProvider["id"]): void {
    this.circuits.delete(id);
  }

  private recordFailure(id: DecisionProvider["id"]): void {
    const threshold = this.config.circuitBreakerThreshold ?? 3;
    const cooldownMs = this.config.circuitBreakerCooldownMs ?? 30_000;
    const state = this.circuits.get(id) ?? { consecutiveFailures: 0 };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= threshold) state.openUntilMs = this.clock() + cooldownMs;
    this.circuits.set(id, state);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, providerId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`provider "${providerId}" exceeded its ${ms}ms budget`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Dedupe identical concurrent requests. State is a bounded, fenced object (§4.4), so JSON-stringifying it is cheap. */
function singleFlightKey(req: DecisionRequest): string {
  return JSON.stringify({ site: req.site, questions: req.questions, state: req.state });
}
