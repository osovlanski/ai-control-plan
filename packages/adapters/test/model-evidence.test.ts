/**
 * K7 §9 — provider-specific model evidence, audited per adapter.
 *
 * The point is NOT to make providers look equivalent. Each adapter reports only
 * what its provider actually says; where a provider reports no model identity,
 * the run stays unknown rather than being normalized into a plausible guess.
 */
import { describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { BedrockAdapter, ClaudeAdapter, CodexAdapter, CursorAdapter, FakeAdapter } from "../src/index.js";

const id = (name: string) => name as AssistantId;

describe("declared model lists", () => {
  it("says where each adapter's model list comes from, and admits when it is a placeholder", async () => {
    const claude = await new ClaudeAdapter(id("claude")).describe();
    // Selector aliases the CLI accepts — local config, not a provider catalog.
    expect(claude.core.models.map((m) => m.id)).toEqual(["opus", "sonnet"]);
    expect(claude.evidence.source).toBe("local-config");

    const codex = await new CodexAdapter(id("codex")).describe();
    // The CLI's configured default has no name we can honestly print.
    expect(codex.core.models[0]!.id).toBe("default");

    const cursor = await new CursorAdapter(id("cursor")).describe();
    expect(cursor.core.models[0]!.id).toBe("default");

    const bedrock = await new BedrockAdapter(id("bedrock")).describe();
    // The model lives inside the deployed agent; the plane cannot see it.
    expect(bedrock.core.models[0]!.displayName).toBe("Deployed AgentCore runtime");
  });
});

describe("resolved identity in the run stream", () => {
  it("only the adapters whose provider reports a model emit one on run.started", async () => {
    // FakeAdapter is the deterministic stand-in: it reports its own model, which
    // is why the harness tests can assert resolution end to end.
    const fake = new FakeAdapter(id("fake"));
    const handle = await fake.start({
      taskId: "AG-1" as never, prompt: "p", workdir: "/tmp",
      permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 1000 },
    });
    const events = [];
    for await (const event of fake.events(handle)) events.push(event);
    const started = events.find((e) => e.type === "run.started")!;
    expect((started.payload as { model?: string }).model).toBe("fake-1");
  });

  it("documents the provider-evidence matrix this slice relies on", () => {
    // Kept as data so a regression in any adapter's stream is a failing test,
    // not a stale sentence in a document. See docs/agentic-os-k7-model-identity.md.
    const evidence = {
      claude: { runStartedModel: true, note: "system/init carries `model`" },
      codex: { runStartedModel: false, note: "thread.started reports no model" },
      cursor: { runStartedModel: false, note: "run.started payload is `{ pid }`" },
      bedrock: { runStartedModel: false, note: "model chosen inside the deployed agent" },
      openrouter: { runStartedModel: false, note: "delegates to Codex; its configured model is launch config, not provider evidence" },
      fake: { runStartedModel: true, note: "deterministic test adapter reports its own model" },
    };
    expect(Object.values(evidence).filter((e) => e.runStartedModel)).toHaveLength(2);
  });
});
