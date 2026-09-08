/**
 * M14 K9 — `CapabilityManifest.context` truth per adapter.
 *
 * The point is NOT to make providers look equivalent. Each adapter declares
 * only what its provider actually exposes; where there is no verified
 * occupancy mechanism the tier is `unavailable`, not a generic estimator. K9
 * never declares a `compact` control (that is K10).
 */
import { describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import {
  BedrockAdapter,
  ClaudeAdapter,
  CodexAdapter,
  CursorAdapter,
  FakeAdapter,
  OpenRouterCodexAdapter,
} from "../src/index.js";

const id = (n: string) => n as AssistantId;

describe("ContextCapability per adapter", () => {
  it("Claude: provider-reported occupancy + effective window, observes auto-compaction, no compact control at K9", async () => {
    const m = await new ClaudeAdapter(id("claude")).describe();
    expect(m.context).toEqual({
      occupancy: "provider-reported",
      effectiveWindow: "provider-reported",
      compact: "none",
      autoManagement: "provider",
      autoManagementDetail: expect.stringContaining("compact_boundary"),
      observesAutoCompaction: true,
    });
  });

  it("Codex: occupancy unavailable — turn.completed accounting is not live occupancy", async () => {
    const m = await new CodexAdapter(id("codex")).describe();
    expect(m.context?.occupancy).toBe("unavailable");
    expect(m.context?.effectiveWindow).toBe("unavailable");
    expect(m.context?.compact).toBe("none");
    expect(m.context?.observesAutoCompaction).toBe(false);
    // Codex manages its own context; it is just not observable at this SDK layer.
    expect(m.context?.autoManagement).toBe("provider");
  });

  it("OpenRouter-in-Codex inherits Codex's honest unavailable context tier", async () => {
    const m = await new OpenRouterCodexAdapter(id("or")).describe();
    expect(m.context?.occupancy).toBe("unavailable");
  });

  it("Cursor: no verified occupancy mechanism", async () => {
    const m = await new CursorAdapter(id("cursor")).describe();
    expect(m.context?.occupancy).toBe("unavailable");
    expect(m.context?.autoManagement).toBe("none");
  });

  it("Bedrock: the context lives inside the deployed agent — unavailable", async () => {
    const m = await new BedrockAdapter(id("bedrock"), {
      agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:1:runtime/a",
    }).describe();
    expect(m.context?.occupancy).toBe("unavailable");
  });

  it("Fake: scripted provider-reported, no compact control", async () => {
    const m = await new FakeAdapter(id("fake")).describe();
    expect(m.context).toMatchObject({
      occupancy: "provider-reported",
      effectiveWindow: "provider-reported",
      compact: "none",
    });
  });

  it("no adapter declares a provider-command compact at K9", async () => {
    const manifests = await Promise.all([
      new ClaudeAdapter(id("c")).describe(),
      new CodexAdapter(id("x")).describe(),
      new CursorAdapter(id("u")).describe(),
      new FakeAdapter(id("f")).describe(),
    ]);
    for (const m of manifests) expect(m.context?.compact).not.toBe("provider-command");
  });
});
