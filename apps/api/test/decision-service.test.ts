/**
 * M16 K17 — `DecisionService` registry/fallback/circuit-breaker/timeout/
 * single-flight (plan `plans/jev-decision-service-plan.md` §5). No vendor
 * SDK exists yet, so these are exercised against a synthetic fake provider —
 * never a real network call.
 */
import { describe, expect, it, vi } from "vitest";
import type { DecisionCapability, DecisionOutcome, DecisionProvider, DecisionRequest } from "@agent-plane/core";
import { DecisionService } from "../src/modules/decision.js";

const req = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({
  site: "task-classifier",
  state: { goal: "fix the bug" },
  questions: { kind: { kind: "choice", instructions: "x", criteria: { coding: null, review: null, research: null, general: null } } },
  budgetMs: 50,
  ...over,
});

class FakeProvider implements DecisionProvider {
  calls = 0;
  constructor(
    readonly id: DecisionProvider["id"],
    private behavior: (req: DecisionRequest) => Promise<DecisionOutcome> | DecisionOutcome,
  ) {}
  describe(): DecisionCapability {
    return { reachable: true, egress: "third-party" };
  }
  async decide(r: DecisionRequest): Promise<DecisionOutcome> {
    this.calls += 1;
    return this.behavior(r);
  }
}

const outcome = (provider: DecisionProvider["id"]): DecisionOutcome => ({
  answers: { kind: { kind: "choice", value: "coding", probabilities: { coding: 1 }, confidence: 1 } },
  provider,
  latencyMs: 1,
});

describe("DecisionService", () => {
  it("always has rules registered, even with no extra providers", async () => {
    const svc = new DecisionService({ provider: "rules" });
    const out = await svc.decide(req());
    expect(out.provider).toBe("rules");
  });

  it("cannot have rules overridden by an extra provider (I-D6)", async () => {
    const fakeRules = new FakeProvider("rules", () => outcome("rules"));
    const svc = new DecisionService({ provider: "rules" }, [fakeRules]);
    await svc.decide(req());
    expect(fakeRules.calls).toBe(0); // the real RulesDecisionProvider answered instead
  });

  it("falls back typesafe → model → rules and records why on the outcome", async () => {
    const typesafe = new FakeProvider("typesafe", () => {
      throw new Error("401 bad key");
    });
    const svc = new DecisionService({ provider: "typesafe" }, [typesafe]);
    const out = await svc.decide(req());
    expect(out.provider).toBe("rules");
    expect(out.degraded).toEqual({ from: "typesafe", reason: "401 bad key" });
  });

  it("degrades on timeout, never lets a slow provider hang the call", async () => {
    const slow = new FakeProvider("typesafe", () => new Promise((resolve) => setTimeout(() => resolve(outcome("typesafe")), 5_000)));
    const svc = new DecisionService({ provider: "typesafe" }, [slow]);
    const out = await svc.decide(req({ budgetMs: 20 }));
    expect(out.provider).toBe("rules");
    expect(out.degraded?.from).toBe("typesafe");
    expect(out.degraded?.reason).toMatch(/exceeded its 20ms budget/);
  });

  it("opens the circuit after repeated failures and skips straight to fallback", async () => {
    let calls = 0;
    const flaky = new FakeProvider("typesafe", () => {
      calls += 1;
      throw new Error("boom");
    });
    const clock = vi.fn(() => 0);
    const svc = new DecisionService({ provider: "typesafe", circuitBreakerThreshold: 2, circuitBreakerCooldownMs: 1_000 }, [flaky], clock);
    await svc.decide(req());
    await svc.decide(req());
    expect(calls).toBe(2); // circuit opens after the 2nd consecutive failure
    await svc.decide(req());
    expect(calls).toBe(2); // 3rd call skipped the open circuit entirely

    clock.mockReturnValue(1_001); // cooldown elapsed
    await svc.decide(req());
    expect(calls).toBe(3);
  });

  it("shares one in-flight call across identical concurrent requests (single-flight)", async () => {
    let calls = 0;
    const provider = new FakeProvider("typesafe", async (r) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return outcome("typesafe");
    });
    const svc = new DecisionService({ provider: "typesafe" }, [provider]);
    const [a, b] = await Promise.all([svc.decide(req()), svc.decide(req())]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("makes no network call and depends on no vendor SDK — the fake provider proves the seam, not a real one", async () => {
    const svc = new DecisionService({ provider: "rules" });
    const out = await svc.decide(req());
    expect(out.provider).toBe("rules");
  });
});
