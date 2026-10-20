/**
 * M2 Composer S3 — the fake adapter's TEST-ONLY `harness` option, which lets a drive stand
 * fake assistants in for any harness. Only the fake provider may read it.
 */
import { describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { BedrockAdapter, ClaudeAdapter, CodexAdapter, CursorAdapter, FakeAdapter, OpenRouterCodexAdapter, type FakeHarness } from "../src/index.js";

const id = (name: string) => name as AssistantId;

describe("fake adapter harness option", () => {
  it("defaults to claude-code, exactly as before the option existed", async () => {
    const fake = new FakeAdapter(id("fake"));
    expect(fake.harness).toBe("claude-code");
    const manifest = await fake.describe();
    expect(manifest.provider).toBe("fake");
    expect(manifest.providerDetail).toEqual({ runtime: "fake", harness: "claude-code" });
    expect((await new FakeAdapter(id("fake"), undefined, {}).describe()).providerDetail.harness).toBe("claude-code");
  });

  it.each<FakeHarness>(["claude-code", "codex", "cursor", "bedrock"])("presents as %s when asked to", async (harness) => {
    const fake = new FakeAdapter(id("fake"), undefined, { harness });
    expect(fake.harness).toBe(harness);
    expect((await fake.describe()).providerDetail.harness).toBe(harness);
  });

  it("changes nothing else about the manifest but the provisioning tier (M3)", async () => {
    const plain = await new FakeAdapter(id("fake")).describe();
    const codex = await new FakeAdapter(id("fake"), undefined, { harness: "codex" }).describe();
    expect(plain.harness?.provisioning).toBe("full");
    expect(codex.harness?.provisioning).toBe("partial");
    const { evidence: plainEvidence, providerDetail: plainDetail, ...plainRest } = plain;
    const { evidence: codexEvidence, providerDetail: codexDetail, ...codexRest } = codex;
    const tierless = (m: typeof plainRest) => ({ ...m, harness: { ...m.harness!, provisioning: undefined } });
    expect(tierless(codexRest)).toEqual(tierless(plainRest));
    expect(codexEvidence.source).toBe(plainEvidence.source);
    expect({ ...codexDetail, harness: undefined }).toEqual({ ...plainDetail, harness: undefined });
  });

  it("refuses an unknown harness at construction instead of coercing it", () => {
    for (const harness of ["gemini", "", "Claude-Code", "codex ", 7]) {
      expect(() => new FakeAdapter(id("fake"), undefined, { harness } as never)).toThrow(/Unknown fake harness/);
    }
  });

  it("is not reachable from a real provider: no real adapter reads or reports it", async () => {
    // The same option bag a workspace config would hand to a non-fake provider.
    const options = { harness: "codex" } as never;
    const real = [
      new ClaudeAdapter(id("claude"), undefined, options),
      new CodexAdapter(id("codex"), options),
      new OpenRouterCodexAdapter(id("router"), options),
      new CursorAdapter(id("cursor"), options),
      new BedrockAdapter(id("bedrock"), options),
    ];
    for (const adapter of real) {
      expect(adapter).not.toBeInstanceOf(FakeAdapter);
      expect("harness" in adapter).toBe(false);
      const manifest = await adapter.describe();
      expect(manifest.provider).not.toBe("fake");
      expect(manifest.providerDetail).not.toHaveProperty("harness");
    }
  });
});
