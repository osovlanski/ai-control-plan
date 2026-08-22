import { describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { BedrockAdapter, CursorSchemaError, calibrateFromSamples, mapCursorLine, parseAgentOutput } from "../src/index.js";

describe("Cursor mapping quarantine", () => {
  it("maps the shapes it does recognise", () => {
    expect(mapCursorLine(JSON.stringify({ type: "assistant", text: "hello" }))).toEqual([
      expect.objectContaining({ type: "message", summary: "hello" }),
    ]);
    expect(mapCursorLine(JSON.stringify({ type: "tool_call", name: "edit_file" }))).toEqual([
      expect.objectContaining({ type: "tool.started", summary: "edit_file" }),
    ]);
    expect(mapCursorLine(JSON.stringify({ type: "tool_result", name: "edit_file", is_error: true }))).toEqual([
      expect.objectContaining({ type: "tool.failed" }),
    ]);
    expect(mapCursorLine(JSON.stringify({ type: "result" }))).toEqual([]);
  });

  it("throws loudly on anything it does not recognise, rather than inventing an event", () => {
    // This is the whole point of the quarantine: the mapping is UNVERIFIED, so
    // silently producing plausible events would hide that a task did nothing.
    expect(() => mapCursorLine(JSON.stringify({ type: "some_future_event", data: 1 }))).toThrow(CursorSchemaError);
    expect(() => mapCursorLine("not json at all")).toThrow(CursorSchemaError);
    expect(() => mapCursorLine(JSON.stringify({ type: "assistant" }))).toThrow(CursorSchemaError);
  });

  it("names the calibration path in the error so the fix is obvious", () => {
    expect(() => mapCursorLine("{}")).toThrow(/UNVERIFIED.*calibrate/is);
  });

  it("calibrateFromSamples reports exactly what is unmapped", () => {
    const result = calibrateFromSamples([
      JSON.stringify({ type: "assistant", text: "hi" }),
      JSON.stringify({ type: "mystery" }),
      "",
    ]);
    expect(result.mapped).toBe(1);
    expect(result.unrecognised).toHaveLength(1);
    expect(result.unrecognised[0]).toContain("mystery");
  });
});

describe("Bedrock adapter", () => {
  const arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agent";

  it("reports capabilities honestly for a hosting platform", async () => {
    const manifest = await new BedrockAdapter("work-bedrock" as AssistantId, { agentRuntimeArn: arn }).describe();
    // Verified from the SDK types: runtimeSessionId round-trips.
    expect(manifest.core.canResume).toBe(true);
    // AWS is metered, not plan-quota'd — no used-percent exists to report.
    expect(manifest.core.reportsLimits).toBe(false);
    expect(manifest.core.reportsUsage).toBe(false);
    // What the DEPLOYED agent can do is not discoverable from here; claiming
    // shell/filesystem would let the router hard-filter on a guess.
    expect(manifest.core.execution).toEqual({ shell: false, filesystem: false, web: "unknown" });
    expect(manifest.providerDetail.agentRuntimeArn).toBe(arn);
  });

  it("treats a missing runtime ARN as unauthenticated instead of failing mid-task", async () => {
    const manifest = await new BedrockAdapter("work-bedrock" as AssistantId).describe();
    expect(manifest.core.auth.state).toBe("missing");
    expect(manifest.core.auth.account).toMatch(/agentRuntimeArn/);
  });

  it("parses both AgentCore response shapes without guessing at agent schemas", () => {
    expect(parseAgentOutput('data: {"a":1}\n\ndata: [DONE]\n', "text/event-stream")).toEqual(['{"a":1}']);
    expect(parseAgentOutput(JSON.stringify({ output: "done" }), "application/json")).toEqual(["done"]);
    expect(parseAgentOutput(JSON.stringify({ unknown: "shape" }), "application/json")).toEqual([
      JSON.stringify({ unknown: "shape" }),
    ]);
    expect(parseAgentOutput("plain text", "text/plain")).toEqual(["plain text"]);
    expect(parseAgentOutput("", "application/json")).toEqual([]);
  });
});
