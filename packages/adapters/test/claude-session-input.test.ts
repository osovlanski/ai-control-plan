/**
 * The live Claude Code session-input adapter, against a CLI that behaves like
 * the real one where it matters.
 *
 * Only the SDK's `query()` is doubled. Everything under test is the shipping
 * code: the streaming-input launch, the uuid derivation, the transcript scan on
 * a real file, the liveness rule and the refusals. The double's one job is the
 * behaviour the real CLI was measured to have — it stamps the caller's uuid
 * into its own `<session-id>.jsonl` transcript, and it does so when it FOLDS
 * the message into a turn, which can be long after the message was pushed.
 */
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionInputRejectedError, SessionInputUnresolvedError, type AssistantId, type RunSpec, type SessionInputTarget } from "@agent-plane/core";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, ClaudeCodeSessionInputAdapter, transcriptUuid } from "../src/index.js";

const SPEC: RunSpec = {
  taskId: "AG-1" as never,
  prompt: "do the mission",
  workdir: "/tmp/live-input-cwd",
  permissionPolicy: { mode: "auto-approve" },
  env: { redactionRules: [], maxRuntimeMs: 10_000 },
};

interface Pushed {
  uuid: string;
  text: string;
}

/** A stand-in Claude Code CLI with the transcript behaviour the real one has. */
class FakeCli {
  readonly projectsDir: string;
  /** Every user message the CLI actually received on stdin, in arrival order. */
  received: Pushed[] = [];
  sessionId = "";
  alive = true;
  /** Fold each message into the transcript as it arrives (the fast-turn case). */
  autoFold = true;
  private cwd = "";
  private finish: () => void = () => {};

  constructor() {
    this.projectsDir = mkdtempSync(join(tmpdir(), "claude-projects-"));
  }

  query = ((args: Record<string, unknown>) => {
    const options = args.options as { sessionId?: string; cwd?: string };
    this.sessionId = options.sessionId ?? "";
    this.cwd = options.cwd ?? "";
    const prompt = args.prompt as string | AsyncIterable<{ uuid: string; message: { content: string } }>;
    const done = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
    const drain = async () => {
      // A default run passes a plain string prompt and has no input channel.
      if (typeof prompt === "string") return;
      for await (const message of prompt) {
        // The mission prompt is the first frame; it is not a session input.
        if (this.received.length === 0 && message.message.content === SPEC.prompt) continue;
        this.received.push({ uuid: message.uuid, text: message.message.content });
        if (this.autoFold) this.fold(message.uuid);
      }
    };
    const sessionId = this.sessionId;
    async function* gen() {
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: "claude-x",
        claude_code_version: "test",
        tools: [],
      } as never;
      // stdin is drained concurrently with the output stream, exactly as the
      // real CLI does: a push can land in the middle of a running turn.
      void drain();
      await done;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        num_turns: 1,
        duration_ms: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as never;
    }
    return gen() as unknown as ReturnType<typeof query>;
  }) as unknown as typeof query;

  /** Write the user line the CLI writes when it folds a message into a turn. */
  fold(uuid: string, overrides: { sessionId?: string; cwd?: string; ownTurn?: boolean } = {}): void {
    const sessionId = overrides.sessionId ?? this.sessionId;
    const dir = join(this.projectsDir, "-slug");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        // Two shapes, both real. Mid-turn (the normal case for session input)
        // the uuid travels as `source_uuid` on a queued_command attachment;
        // between turns the message becomes its own `user` line.
        ...(overrides.ownTurn
          ? { type: "user", uuid }
          : { type: "attachment", attachment: { type: "queued_command", source_uuid: uuid, prompt: "" }, uuid: `cli-${uuid}` }),
        sessionId,
        cwd: overrides.cwd ?? this.cwd,
        timestamp: "2026-09-20T10:00:00.000Z",
        message: { role: "user", content: this.received.find((r) => r.uuid === uuid)?.text ?? "" },
      })}\n`,
    );
  }

  /** End the turn: the query completes and the input channel closes with it. */
  end(): void {
    this.alive = false;
    this.finish();
  }

  transcriptLines(sessionId = this.sessionId): unknown[] {
    const file = join(this.projectsDir, "-slug", `${sessionId}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe("live Claude Code session input", () => {
  const clis: FakeCli[] = [];

  afterEach(() => {
    for (const cli of clis.splice(0)) cli.end();
  });

  /** A started live-input run plus the session-input adapter over it. */
  async function start(opts: { autoFold?: boolean } = {}) {
    const cli = new FakeCli();
    cli.autoFold = opts.autoFold !== false;
    clis.push(cli);
    const agent = new ClaudeAdapter("claude" as AssistantId, cli.query, { liveInput: true });
    const handle = await agent.start(SPEC);
    const inputs = new ClaudeCodeSessionInputAdapter((id) => agent.liveSession(id), {
      projectsDir: cli.projectsDir,
      ackTimeoutMs: 120,
      reconcileGraceMs: 60,
      pollIntervalMs: 5,
      processAlive: () => cli.alive,
    });
    const live = agent.liveSession(handle.runId)!;
    const target: SessionInputTarget = {
      sessionId: handle.runId,
      assistantId: "claude",
      providerSessionRef: live.providerSessionRef,
    };
    // Let the run's own first frame settle so the mission prompt is consumed.
    await settle();
    return { cli, agent, handle, inputs, target, live };
  }

  it("proves delivery from the CLI's own transcript, not from a successful write", async () => {
    const { cli, inputs, target } = await start();
    const receipt = await inputs.deliver(target, { messageId: "msg_1", kind: "text", text: "follow up" });

    const uuid = transcriptUuid("msg_1");
    expect(receipt).toMatchObject({
      messageId: "msg_1",
      ackLevel: "provider-accepted",
      reference: `transcript:${cli.sessionId}#${uuid}`,
    });
    // The evidence is the provider's own record, carrying OUR message identity.
    expect(cli.transcriptLines()).toMatchObject([
      { type: "attachment", sessionId: cli.sessionId, attachment: { type: "queued_command", source_uuid: uuid } },
    ]);
    expect(cli.received).toEqual([{ uuid, text: "follow up" }]);
  });

  it("declares transport-only evidence insufficient: a push with no fold is UNKNOWN, not delivered", async () => {
    const { cli, inputs, target } = await start({ autoFold: false });

    const err = await inputs
      .deliver(target, { messageId: "msg_2", kind: "text", text: "queued behind a long turn" })
      .catch((e: unknown) => e);

    // Not a rejection: a rejection would claim the message definitely did not
    // arrive, and the CLI is still holding it.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SessionInputRejectedError);
    // It really did reach the process — that is exactly why this is ambiguous.
    expect(cli.received).toHaveLength(1);
    expect(cli.transcriptLines()).toHaveLength(0);
  });

  it("resolves an ambiguous delivery by reading the transcript, never by sending again", async () => {
    const { cli, inputs, target } = await start({ autoFold: false });
    await inputs.deliver(target, { messageId: "msg_3", kind: "text", text: "hello" }).catch(() => {});

    // The long turn finally folds the message the adapter had given up on.
    cli.fold(transcriptUuid("msg_3"));

    const receipt = await inputs.lookupReceipt(target, "msg_3");
    expect(receipt).toMatchObject({ messageId: "msg_3", ackLevel: "provider-accepted" });
    // The whole point: reconciliation delivered nothing a second time.
    expect(cli.received).toHaveLength(1);
    expect(cli.transcriptLines()).toHaveLength(1);
  });

  it("refuses to call a live process authoritatively empty", async () => {
    const { cli, inputs, target } = await start({ autoFold: false });
    await inputs.deliver(target, { messageId: "msg_4", kind: "text", text: "still queued" }).catch(() => {});

    // `null` here would authorise a second send while the CLI still holds the
    // first one. The adapter says it cannot tell instead.
    await expect(inputs.lookupReceipt(target, "msg_4")).rejects.toBeInstanceOf(SessionInputUnresolvedError);
    expect(cli.received).toHaveLength(1);
  });

  it("treats absence as final once the process is gone", async () => {
    const { cli, inputs, target } = await start({ autoFold: false });
    await inputs.deliver(target, { messageId: "msg_5", kind: "text", text: "never folded" }).catch(() => {});
    cli.end();
    await settle();

    // A dead CLI can fold nothing later, so absence is now a fact.
    await expect(inputs.lookupReceipt(target, "msg_5")).resolves.toBeNull();
  });

  it("counts a message the CLI folded on its way out as delivered", async () => {
    const { cli, inputs, target } = await start({ autoFold: false });
    await inputs.deliver(target, { messageId: "msg_6", kind: "text", text: "folded late" }).catch(() => {});
    cli.fold(transcriptUuid("msg_6"));
    cli.end();
    await settle();

    // The file is the arbiter, not our timing.
    await expect(inputs.lookupReceipt(target, "msg_6")).resolves.toMatchObject({ messageId: "msg_6" });
  });

  it("rejects truthfully when the session has no CLI process at all", async () => {
    const { inputs, target } = await start();
    const err = await inputs
      .deliver({ ...target, sessionId: "run_not_running" }, { messageId: "msg_7", kind: "text", text: "hi" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionInputRejectedError);
    expect((err as SessionInputRejectedError).reason).toBe("provider_session_unavailable");
  });

  it("never reaches a CLI process belonging to another provider session", async () => {
    const { cli, inputs, target } = await start();
    const foreign = { ...target, providerSessionRef: "someone-elses-session" };

    const err = await inputs.deliver(foreign, { messageId: "msg_8", kind: "text", text: "leak" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionInputRejectedError);
    expect((err as SessionInputRejectedError).reason).toBe("provider_session_mismatch");
    // Nothing was written into the live run that the kernel record disagrees with.
    expect(cli.received).toHaveLength(0);
    await expect(inputs.lookupReceipt(foreign, "msg_8")).rejects.toBeInstanceOf(SessionInputRejectedError);
  });

  it("does not accept another session's transcript line as this session's receipt", async () => {
    const { cli, inputs, target } = await start({ autoFold: false });
    await inputs.deliver(target, { messageId: "msg_9", kind: "text", text: "mine" }).catch(() => {});
    // Same uuid, a different provider session: it answers for that session only.
    cli.fold(transcriptUuid("msg_9"), { sessionId: "other-session" });
    cli.end();
    await settle();

    await expect(inputs.lookupReceipt(target, "msg_9")).resolves.toBeNull();
  });

  it("does not accept a transcript line from another workspace directory", async () => {
    const { cli, inputs, target } = await start({ autoFold: false });
    await inputs.deliver(target, { messageId: "msg_10", kind: "text", text: "mine" }).catch(() => {});
    cli.fold(transcriptUuid("msg_10"), { cwd: "/tmp/some-other-workspace" });

    await expect(inputs.lookupReceipt(target, "msg_10")).rejects.toBeInstanceOf(SessionInputUnresolvedError);
  });

  it("accepts the between-turns shape too, where the message became its own user turn", async () => {
    const { cli, inputs, target } = await start({ autoFold: false });
    await inputs.deliver(target, { messageId: "msg_own", kind: "text", text: "own turn" }).catch(() => {});
    cli.fold(transcriptUuid("msg_own"), { ownTurn: true });

    await expect(inputs.lookupReceipt(target, "msg_own")).resolves.toMatchObject({
      messageId: "msg_own",
      ackLevel: "provider-accepted",
    });
  });

  it("gives one server message exactly one provider identity", () => {
    // A retry must never mint a second identity for the same logical message.
    expect(transcriptUuid("msg_x")).toBe(transcriptUuid("msg_x"));
    expect(transcriptUuid("msg_x")).not.toBe(transcriptUuid("msg_y"));
    expect(transcriptUuid("msg_x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("reports no capability for a session whose CLI has exited, and none at all without live-input mode", async () => {
    const { cli, inputs, target, agent, handle } = await start();
    await expect(inputs.probeTarget(target)).resolves.toMatchObject({ available: true });

    cli.end();
    await settle();
    await expect(inputs.probeTarget(target)).resolves.toEqual({ available: false, reason: "no_live_provider_session" });
    expect(agent.liveSession(handle.runId)).toBeUndefined();

    // A default (non-live-input) ClaudeAdapter exposes no session at all, so a
    // workspace with the flag off cannot be delivered to even by mistake.
    const plain = new ClaudeAdapter("claude" as AssistantId, new FakeCli().query);
    const plainHandle = await plain.start(SPEC);
    expect(plain.liveSession(plainHandle.runId)).toBeUndefined();
  });
});
