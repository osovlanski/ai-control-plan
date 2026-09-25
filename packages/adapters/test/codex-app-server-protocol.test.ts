import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { SpikeProtocol, steerAckCeiling } from "./support/codex-app-server-protocol.js";

function fixture(timeoutMs = 1000) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  input.on("data", (chunk) => { written += String(chunk); });
  const protocol = new SpikeProtocol(input, output, undefined, timeoutMs);
  return { input, output, protocol, requests: () => written.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

describe("bounded app-server protocol spike", () => {
  it("initializes once before thread resume and matches fragmented responses by request id", async () => {
    const f = fixture();
    const initialized = f.protocol.initialize();
    expect(f.requests()[0]).toMatchObject({ id: 1, method: "initialize" });
    f.output.write('{"id":1,"res');
    f.output.write('ult":{}}\n');
    await initialized;
    expect(f.requests()[1]).toMatchObject({ method: "initialized" });
    const resumed = f.protocol.request("thread/resume", { threadId: "same-thread" });
    f.output.write('{"method":"thread/started","params":{}}\n{"id":2,"result":{"thread":{"id":"same-thread"}}}\n');
    await expect(resumed).resolves.toMatchObject({ result: { thread: { id: "same-thread" } } });
    f.protocol.disconnect();
  });

  it("sends exact steer identity and never upgrades a successful response beyond transport", async () => {
    const f = fixture();
    const pending = f.protocol.request("turn/steer", { threadId: "thread-a", expectedTurnId: "turn-a", input: [{ type: "text", text: "follow-up" }] });
    expect(f.requests()).toEqual([{ id: 1, method: "turn/steer", params: { threadId: "thread-a", expectedTurnId: "turn-a", input: [{ type: "text", text: "follow-up" }] } }]);
    f.output.write('{"id":1,"result":{"turnId":"turn-a","ackLevel":"provider-consumed"}}\n');
    expect(steerAckCeiling(await pending)).toBe("transport");
    expect(steerAckCeiling({ error: { code: -32600, message: "no active turn" } })).toBeUndefined();
    f.protocol.disconnect();
  });

  it("leaves a lost response unresolved without replay, including after a late response", async () => {
    const f = fixture(10);
    await expect(f.protocol.request("turn/steer", {})).rejects.toThrow("app_server_response_timeout");
    f.output.write('{"id":1,"result":{"turnId":"turn-a"}}\n');
    expect(f.requests()).toHaveLength(1);
    f.protocol.disconnect();
  });

  it("rejects all outstanding requests on disconnection and never resends", async () => {
    const f = fixture();
    const pending = f.protocol.request("turn/steer", {});
    f.protocol.disconnect();
    await expect(pending).rejects.toThrow("app_server_disconnected");
    await expect(f.protocol.request("turn/steer", {})).rejects.toThrow("app_server_disconnected");
    expect(f.requests()).toHaveLength(1);
  });

  it("refuses server-initiated approval requests", async () => {
    const f = fixture();
    f.output.write('{"id":99,"method":"item/commandExecution/requestApproval","params":{}}\n');
    expect(f.requests()).toEqual([{ id: 99, error: { code: -32601, message: "Unsupported by control plane" } }]);
    f.protocol.disconnect();
  });

  it.each(["not json", "null", "[]"])("treats malformed protocol output %s as unresolved", async line => {
    const f = fixture();
    const pending = f.protocol.request("turn/steer", {});
    f.output.write(line + '\n');
    await expect(pending).rejects.toThrow("app_server_disconnected");
    expect(f.requests()).toHaveLength(1);
  });
});
