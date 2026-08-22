import { describe, expect, it } from "vitest";
import { redactEvent, redactText } from "../src/index.js";
import type { NormalizedEvent, RunId } from "../src/index.js";
describe("redaction", () => {
  it("removes realistic secrets from normalized payload and full raw provider data", () => {
    const secret = "sk-proj_abcdefghijklmnopqrstuvwxyz012345";
    const event: NormalizedEvent = { runId: "run_1" as RunId, ts: new Date().toISOString(), type: "tool.completed", summary: `Bearer abc.def.ghi ${secret}`, payload: { output: `API_TOKEN=${secret}\nSAFE=yes`, access_token: "opaque-token" }, raw: { request: { authorization: "Bearer abcdefghijklmnop", body: secret }, env: `PASSWORD=hunter2\nOPENAI_API_KEY=${secret}` } };
    const serialized = JSON.stringify(redactEvent(event));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("opaque-token");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).toContain("[REDACTED]");
  });
  it("redacts env file contents in rendered text", () => {
    expect(redactText("DATABASE_PASSWORD=correct-horse\nNORMAL=value")).toBe("DATABASE_PASSWORD=[REDACTED]\nNORMAL=value");
  });
});
