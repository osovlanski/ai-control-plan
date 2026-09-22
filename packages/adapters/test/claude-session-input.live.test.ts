/**
 * The one check the deterministic suite cannot make: a REAL Claude Code CLI
 * process, real credentials, real transcript.
 *
 * Skipped unless `LIVE_CLAUDE_SESSION_INPUT=1`, because it spawns a real agent
 * turn and spends real quota — CI cannot run it cleanly, and pretending it can
 * would be exactly the kind of claim this slice exists to avoid. Run it by hand
 * when the adapter's delivery mechanism changes:
 *
 *   LIVE_CLAUDE_SESSION_INPUT=1 pnpm --filter @agent-plane/adapters \
 *     exec vitest run test/claude-session-input.live.test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantId, NormalizedEvent, RunSpec } from "@agent-plane/core";
import { ClaudeAdapter, ClaudeCodeSessionInputAdapter, transcriptUuid } from "../src/index.js";

const LIVE = process.env.LIVE_CLAUDE_SESSION_INPUT === "1";

describe.skipIf(!LIVE)("live Claude Code CLI — real delivery acknowledgement", () => {
  it("delivers a session-addressed message into a running turn and proves it from the CLI's transcript", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "live-session-input-"));
    const agent = new ClaudeAdapter("claude-live" as AssistantId, undefined, { liveInput: true });
    const spec: RunSpec = {
      taskId: "AG-LIVE" as never,
      // Long enough that the message below lands MID-TURN, which is the case
      // that matters: the CLI queues it and folds it into the running turn.
      prompt: "Run the bash command `sleep 20`, then reply with exactly: MISSION-DONE",
      workdir,
      model: { id: "claude-haiku-4-5-20251001" },
      permissionPolicy: { mode: "auto-approve" },
      env: { redactionRules: [], maxRuntimeMs: 180_000 },
    };

    const handle = await agent.start(spec);
    const events: NormalizedEvent[] = [];
    const pump = (async () => {
      for await (const e of agent.events(handle)) events.push(e);
    })();

    // Wait until the turn is genuinely busy before sending.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !events.some((e) => e.type === "tool.started")) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(events.some((e) => e.type === "tool.started")).toBe(true);

    const inputs = new ClaudeCodeSessionInputAdapter((id) => agent.liveSession(id), { ackTimeoutMs: 120_000 });
    const live = agent.liveSession(handle.runId)!;
    const target = { sessionId: handle.runId, assistantId: "claude-live", providerSessionRef: live.providerSessionRef };

    await expect(inputs.probeTarget(target)).resolves.toMatchObject({ available: true });

    const messageId = `msg_live_${Date.now()}`;
    const receipt = await inputs.deliver(target, { messageId, kind: "text", text: "Also say exactly: LIVE-INPUT-OK" });

    const uuid = transcriptUuid(messageId);
    expect(receipt).toMatchObject({
      messageId,
      ackLevel: "provider-accepted",
      reference: `transcript:${live.providerSessionRef}#${uuid}`,
    });
    // The same evidence answers a cold reconciliation, which is what makes
    // restart correctness work against a real process.
    await expect(inputs.lookupReceipt(target, messageId)).resolves.toMatchObject({ messageId });

    await agent.cancel(handle);
    await pump;
  }, 240_000);
});
