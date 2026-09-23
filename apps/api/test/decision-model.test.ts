/**
 * M16 K19d — `ModelDecisionProvider` contracts, credential-free (stub
 * transport). What must hold for a model in the security path: absence is
 * absence (I-D5), malformed is a failure (I-D2), the budget degrades to
 * prompt, rules deny stays final (I-D1), and no credential means no judge
 * (I-D8).
 */
import { describe, expect, it } from "vitest";
import { TOOL_GATE_BATTERY, buildToolGateState, resolveToolGate, type DecisionRequest } from "@agent-plane/core";
import { ModelDecisionProvider } from "../src/modules/decision-model.js";
import { DecisionService } from "../src/modules/decision.js";

const req = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({
  site: "tool-gate",
  state: buildToolGateState({ toolName: "bash", commandText: "rm -rf ./src", toolsDeny: [] }).state,
  questions: TOOL_GATE_BATTERY,
  budgetMs: 2_000,
  ...over,
});

const LOW = {
  risk: { value: "low", probabilities: { none: 0.1, low: 0.8, medium: 0.1, high: 0, severe: 0 }, confidence: 0.8 },
  destructive: 0.05,
  outside_repo: 0.01,
  exfiltration: 0.01,
  credential_reach: 0.01,
};

/** A Messages API response carrying `body` as the structured-output text. */
function stub(body: unknown, over: Record<string, unknown> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 812, output_tokens: 140 },
        ...over,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const provider = (fetch: typeof globalThis.fetch, key: string | null = "test-key") =>
  new ModelDecisionProvider({ apiKey: () => key ?? undefined, fetch });

describe("ModelDecisionProvider (K19d)", () => {
  it("answers the judged keys through output_config.format, never forced tool use", async () => {
    const { fetch, sent } = stub(LOW);
    const out = await provider(fetch).decide(req());
    expect(sent[0]!.output_config).toMatchObject({ format: { type: "json_schema" } });
    expect(sent[0]!.tool_choice).toBeUndefined();
    expect(sent[0]!.tools).toBeUndefined();
    // The state is fenced in the user turn; the instructions are only in system.
    expect(JSON.stringify(sent[0]!.messages)).toContain("<STATE>");
    expect(String(sent[0]!.system)).not.toContain("rm -rf");
    expect(out.provider).toBe("model");
    expect(out.modelReported).toBe("claude-haiku-4-5-20251001");
    expect(out.usage).toEqual({ inputTokens: 812, outputTokens: 140 });
    // `denied` is the rules port's, beside the judged keys (§5 K18 baseline).
    expect(out.answers.denied).toEqual({ kind: "noul", value: 0 });
    expect(out.answers.risk).toMatchObject({ kind: "score", value: "low" });
    expect(resolveToolGate({ rulesDenied: false, approvalMode: "prompt-on-escalation", outcome: out }).outcome).toBe("auto-approve");
  });

  it("no basis (no command text in the state): no call, judged keys ABSENT, and absence prompts (I-D5)", async () => {
    const { fetch, sent } = stub(LOW);
    const out = await provider(fetch).decide(req({ state: buildToolGateState({ toolName: "bash", toolsDeny: [] }).state }));
    expect(sent).toHaveLength(0);
    expect(out.provider).toBe("rules");
    expect(Object.keys(out.answers)).toEqual(["denied"]);
    expect(resolveToolGate({ rulesDenied: false, approvalMode: "auto-approve", outcome: out })).toMatchObject({
      outcome: "prompt",
      reason: expect.stringContaining("no basis"),
    });
  });

  for (const [name, body, over] of [
    ["not JSON", "risk: low", {}],
    ["out-of-range probability", { ...LOW, destructive: 1.7 }, {}],
    ["unknown risk level", { ...LOW, risk: { ...LOW.risk, value: "fine" } }, {}],
    ["missing key", { risk: LOW.risk }, {}],
    ["null in place of an answer", { ...LOW, outside_repo: null }, {}],
    ["truncated by max_tokens", LOW, { stop_reason: "max_tokens" }],
    ["refusal", LOW, { stop_reason: "refusal" }],
  ] as const) {
    it(`malformed output (${name}) degrades to prompt, never to a low-risk answer (I-D2)`, async () => {
      const { fetch } = stub(body, over);
      const service = new DecisionService({ provider: "model" }, [provider(fetch)]);
      const out = await service.decide(req());
      expect(out.provider).toBe("rules");
      expect(out.degraded?.from).toBe("model");
      expect(out.answers.risk).toBeUndefined();
      expect(resolveToolGate({ rulesDenied: false, approvalMode: "auto-approve", outcome: out }).outcome).toBe("prompt");
    });
  }

  it("a judge slower than budgetMs degrades to prompt and its request is aborted", async () => {
    let aborted = false;
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof globalThis.fetch;
    const service = new DecisionService({ provider: "model" }, [provider(hang)]);
    const out = await service.decide(req({ budgetMs: 50 }));
    expect(out.degraded?.from).toBe("model");
    expect(resolveToolGate({ rulesDenied: false, approvalMode: "auto-approve", outcome: out }).outcome).toBe("prompt");
    await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe(true);
  });

  it("a rules deny stays final whatever the judge says (I-D1)", async () => {
    const { fetch } = stub({ ...LOW, risk: { ...LOW.risk, value: "none" } });
    const out = await provider(fetch).decide(req());
    expect(resolveToolGate({ rulesDenied: true, approvalMode: "auto-approve", outcome: out }).outcome).toBe("block");
  });

  it("no credential: no call, no judge, and applied is refused (I-D8)", async () => {
    const { fetch, sent } = stub(LOW);
    const p = provider(fetch, null);
    expect(p.describe()).toEqual({ reachable: false, egress: "byo-account" });
    const service = new DecisionService({ provider: "model" }, [p]);
    expect(service.activation("tool-gate", "applied").mode).toBe("shadow");
    const out = await service.decide(req());
    expect(sent).toHaveLength(0);
    expect(out.degraded?.reason).toContain("no credential");
    expect(out.degraded?.reason).not.toContain("test-key");
  });

  it("an error names status and class, never the request or the key", async () => {
    const fail = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key test-key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const out = await new DecisionService({ provider: "model" }, [provider(fail)]).decide(req());
    expect(out.degraded?.reason).toMatch(/^model provider 401 /);
    expect(out.degraded?.reason).not.toContain("test-key");
    expect(out.degraded?.reason).not.toContain("rm -rf");
  });

  it("judges nothing at other sites — the rules port answers and says so", async () => {
    const { fetch, sent } = stub(LOW);
    const out = await provider(fetch).decide({
      site: "task-classifier",
      state: { goal: "fix the bug" },
      questions: { kind: { kind: "choice", instructions: "kind", criteria: { coding: null } } },
      budgetMs: 100,
    });
    expect(sent).toHaveLength(0);
    expect(out.provider).toBe("rules");
  });
});
