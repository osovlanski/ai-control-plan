/**
 * M16 Decision Service — provider registry and fallback chain (plan
 * `plans/jev-decision-service-plan.md` §5, K17).
 *
 * No vendor call exists yet: only `RulesDecisionProvider` is registered.
 * `typesafe` and `model` are named in the fallback chain because the chain's
 * SHAPE is part of this slice's seam — a later slice registers real
 * providers for those ids and nothing here changes (I-D6).
 */
import type { DecisionOutcome, DecisionProvider, DecisionRequest } from "@agent-plane/core";
import { RulesDecisionProvider } from "@agent-plane/core";

export interface DecisionServiceConfig {
  /** The first provider to try. The chain still falls back toward "rules". */
  provider: DecisionProvider["id"];
  /** Consecutive failures before a provider's circuit opens. */
  circuitBreakerThreshold?: number;
  /** How long an open circuit stays open before the next attempt is allowed. */
  circuitBreakerCooldownMs?: number;
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
  ) {
    for (const p of extraProviders) this.providers.set(p.id, p);
    this.providers.set("rules", new RulesDecisionProvider());
  }

  async decide(req: DecisionRequest): Promise<DecisionOutcome> {
    const key = singleFlightKey(req);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.decideUncached(req).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
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
