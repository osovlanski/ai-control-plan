/**
 * M16 Decision Service — provider registry and fallback chain (plan
 * `plans/jev-decision-service-plan.md` §5, K17), plus the K18 decision-record
 * write path.
 *
 * No vendor call exists yet: only `RulesDecisionProvider` is registered.
 * `typesafe` and `model` are named in the fallback chain because the chain's
 * SHAPE is part of this slice's seam — a later slice registers real
 * providers for those ids and nothing here changes (I-D6).
 */
import { createHash } from "node:crypto";
import type { DecisionOutcome, DecisionProvider, DecisionRequest, DecisionSite } from "@agent-plane/core";
import { RulesDecisionProvider } from "@agent-plane/core";
import type { Db } from "../db/index.js";

export interface DecisionServiceConfig {
  /** The first provider to try. The chain still falls back toward "rules". */
  provider: DecisionProvider["id"];
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
  mode: "shadow" | "applied";
  degradedReason: string | null;
  stateTruncated: boolean;
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
       (task_id, session_id, site, provider, model_reported, question_set_hash, answers_json, latency_ms, input_tokens, mode, degraded_reason, state_truncated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ctx.taskId ?? null,
    ctx.sessionId ?? null,
    req.site,
    outcome.provider,
    outcome.modelReported ?? null,
    questionSetHash(req.questions),
    JSON.stringify(outcome.answers),
    outcome.latencyMs,
    // No K17/K18 provider does its own token accounting yet — NULL is honest,
    // a fabricated count would not be (I-D5's discipline applies here too).
    null,
    ctx.mode,
    outcome.degraded?.reason ?? null,
    // §4.4 deterministic truncation, as the builder reported it — a truncated
    // state is a named condition on the record, never a silent one.
    ctx.stateTruncated ? 1 : 0,
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
    mode: "shadow" | "applied";
    degraded_reason: string | null;
    state_truncated: number;
    created_at: string;
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
    mode: r.mode,
    degradedReason: r.degraded_reason,
    stateTruncated: r.state_truncated === 1,
    createdAt: r.created_at,
  }));
}

/**
 * Every `DecisionProvider` this build has BEYOND `RulesDecisionProvider`,
 * which `DecisionService` always registers itself (I-D6).
 *
 * Empty today — no vendor call exists (§5 K17). It is a function rather than
 * an inline `[]` so that the slice registering `TypeSafeDecisionProvider` or
 * `ModelDecisionProvider` edits ONE place and every consumer picks it up with
 * no change of its own: the composition root, and the §7.2 prompt-injection
 * suite, which only becomes a real measurement once a provider that can judge
 * risk is registered here.
 */
export function decisionProviders(_config: DecisionServiceConfig): DecisionProvider[] {
  return [];
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
