/**
 * Restart and ambiguous-delivery correctness against the REAL Claude Code
 * session-input adapter, through the real service, routes and SQLite ledger.
 *
 * The double here is only the CLI process: an object that holds a stdin queue
 * and writes the transcript line the measured CLI writes when it folds a
 * message. Everything the correctness argument rests on — the uuid identity,
 * the transcript scan, the liveness rule, lease fencing, the retry gate — is
 * the shipping code.
 *
 * The difference from the fake adapter's version of these cases is the point:
 * `FakeSessionInputAdapter` declares `idempotentSend`, so an unknown outcome
 * can be resolved by sending again. The real CLI appends a second user turn
 * instead, so the only safe resolution is to read the provider's own record —
 * and when that record cannot be authoritative yet, to refuse to send at all.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeSessionInputAdapter, transcriptUuid, type ClaudeLiveSession } from "@agent-plane/adapters";
import type { SessionInputAdapterResolver } from "../src/modules/session-input.js";
import type { Db } from "../src/db/index.js";
import type { BuiltServer } from "../src/server.js";
import { boot, command, seedSession, send, type Workspace } from "./helpers/session-input.js";

let home: string;
const open: Db[] = [];
const servers: BuiltServer[] = [];

function track(ws: Workspace): Workspace {
  open.push(ws.db);
  servers.push(ws.built);
  return ws;
}

async function kill(ws: Workspace): Promise<void> {
  await ws.built.app.close();
  ws.db.close();
  servers.splice(servers.indexOf(ws.built), 1);
  open.splice(open.indexOf(ws.db), 1);
}

const CWD = "/tmp/live-workspace";

/**
 * One Claude Code CLI process, as far as the adapter can see it: something to
 * push into, and a transcript it writes on its own schedule. It survives a
 * server restart, exactly as a provider process would.
 */
class LiveCli {
  readonly projectsDir = mkdtempSync(join(tmpdir(), "live-projects-"));
  readonly received: Array<{ uuid: string; text: string }> = [];
  alive = true;
  /** Fold on arrival (fast turn) or hold the message in the queue (long turn). */
  autoFold = true;

  constructor(readonly ref: string) {}

  session(): ClaudeLiveSession {
    return {
      providerSessionRef: this.ref,
      cwd: CWD,
      alive: () => this.alive,
      push: (uuid, text) => {
        this.received.push({ uuid, text });
        if (this.autoFold) this.fold(uuid);
      },
    };
  }

  fold(uuid: string): void {
    const dir = join(this.projectsDir, "-slug");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `${this.ref}.jsonl`),
      `${JSON.stringify({
        // The mid-turn shape the real CLI writes: our uuid travels as
        // `source_uuid` on a queued_command attachment, under the CLI's own uuid.
        type: "attachment",
        attachment: { type: "queued_command", source_uuid: uuid, prompt: "" },
        uuid: `cli-${uuid}`,
        sessionId: this.ref,
        cwd: CWD,
        timestamp: "2026-09-20T10:00:00.000Z",
        message: { role: "user", content: this.received.find((r) => r.uuid === uuid)?.text ?? "" },
      })}\n`,
    );
  }

  transcript(): unknown[] {
    const file = join(this.projectsDir, "-slug", `${this.ref}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}

/** Wires the real adapter over one CLI, for the Claude assistant only. */
function resolver(sessionId: string, cli: LiveCli): SessionInputAdapterResolver {
  const adapter = new ClaudeCodeSessionInputAdapter((id) => (id === sessionId && cli.alive ? cli.session() : undefined), {
    projectsDir: cli.projectsDir,
    ackTimeoutMs: 80,
    reconcileGraceMs: 40,
    pollIntervalMs: 5,
    processAlive: () => cli.alive,
  });
  return (assistantId) => (assistantId === "real-a" ? adapter : undefined);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-input-live-"));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const db of open.splice(0)) db.close();
  rmSync(home, { recursive: true, force: true });
});

/** One live Claude session plus a workspace wired to its adapter. */
function liveWorkspace(opts: { autoFold?: boolean } = {}): { ws: Workspace; cli: LiveCli; sessionId: string } {
  const sessionId = `run_live_${Math.random().toString(36).slice(2, 8)}`;
  const cli = new LiveCli(`provider-${sessionId}`);
  cli.autoFold = opts.autoFold !== false;
  const ws = track(boot(home, { adapters: resolver(sessionId, cli) }));
  seedSession(ws.db, { sessionId, assistantId: "real-a" });
  return { ws, cli, sessionId };
}

describe("live Claude Code delivery", () => {
  it("delivers for real and carries the provider's own receipt", async () => {
    const { ws, cli, sessionId } = liveWorkspace();
    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "please continue" });

    expect(res.statusCode).toBe(202);
    const uuid = transcriptUuid(res.body.id as string);
    expect(res.body).toMatchObject({
      state: "delivered",
      deliveryUnknown: false,
      providerReceipt: { reference: `transcript:${cli.ref}#${uuid}`, ackLevel: "provider-accepted" },
    });
    expect(cli.received).toEqual([{ uuid, text: "please continue" }]);
    expect(cli.transcript()).toHaveLength(1);
    // The attempt records the capability the claim was made under.
    expect(ws.built.sessionInputs!.attempts(res.body.id as string)).toMatchObject([
      { outcome: "delivered", capabilityVersion: "claude-code-session-input/1" },
    ]);
  });

  it("rejects truthfully when the CLI process is not running", async () => {
    const { ws, cli, sessionId } = liveWorkspace();
    cli.alive = false;

    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "anyone there?" });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ state: "rejected", reason: "provider_session_unavailable" });
    // Not queued forever, and certainly not marked delivered.
    expect(cli.received).toHaveLength(0);
  });

  it("keeps an unacknowledged push UNKNOWN rather than calling it sent or failed", async () => {
    const { ws, cli, sessionId } = liveWorkspace({ autoFold: false });

    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "behind a long turn" });
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    expect(cli.received).toHaveLength(1);
    expect(ws.built.sessionInputs!.events(res.body.id as string).map((e) => e.type)).toEqual([
      "input.queued", "input.accepted", "input.delivery_unknown",
    ]);
  });

  it("refuses to re-send while the CLI could still fold the first copy", async () => {
    const { ws, cli, sessionId } = liveWorkspace({ autoFold: false });
    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "still queued" });
    const messageId = res.body.id as string;

    // The retry is LEGAL — the delivery is unknown — but it must reconcile, and
    // reconciliation cannot conclude anything while the process is alive.
    const retry = await command(ws, messageId, "retry");
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toMatchObject({ state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" });
    // The one thing that must never happen: a second copy in the CLI.
    expect(cli.received).toHaveLength(1);
  });

  it("converges on one delivered message when the server dies and the CLI folds meanwhile", async () => {
    const sessionId = `run_live_${Math.random().toString(36).slice(2, 8)}`;
    const cli = new LiveCli(`provider-${sessionId}`);
    cli.autoFold = false;
    const first = track(boot(home, { adapters: resolver(sessionId, cli) }));
    seedSession(first.db, { sessionId, assistantId: "real-a" });

    const res = await send(first, sessionId, { clientMessageId: "client-key", text: "reconcile me" });
    const messageId = res.body.id as string;
    expect(res.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    const deadEpoch = first.built.sessionInputs!.leaseEpoch;
    await kill(first);

    // While the plane was down the long turn ended and the CLI folded the
    // message it had been holding. The provider's record is the only witness.
    cli.fold(transcriptUuid(messageId));

    const second = track(boot(home, { adapters: resolver(sessionId, cli) }));
    expect(second.built.sessionInputs!.leaseEpoch).not.toBe(deadEpoch);

    const retry = await send(second, sessionId, { clientMessageId: "client-key", text: "reconcile me" });
    expect(retry.statusCode).toBe(202);
    expect(retry.body).toMatchObject({ id: messageId, state: "delivered", deliveryUnknown: false });
    // One logical message, one push, one transcript line.
    expect(cli.received).toHaveLength(1);
    expect(cli.transcript()).toHaveLength(1);
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 1 });
  });

  it("settles as not delivered when the CLI died without ever folding it", async () => {
    const sessionId = `run_live_${Math.random().toString(36).slice(2, 8)}`;
    const cli = new LiveCli(`provider-${sessionId}`);
    cli.autoFold = false;
    const first = track(boot(home, { adapters: resolver(sessionId, cli) }));
    seedSession(first.db, { sessionId, assistantId: "real-a" });

    const res = await send(first, sessionId, { clientMessageId: "client-key", text: "lost with the process" });
    const messageId = res.body.id as string;
    await kill(first);

    // The CLI went down with the plane and folded nothing: absence is now a fact.
    cli.alive = false;

    const second = track(boot(home, { adapters: resolver(sessionId, cli) }));
    const retry = await send(second, sessionId, { clientMessageId: "client-key", text: "lost with the process" });
    expect(retry.statusCode).toBe(422);
    expect(retry.body).toMatchObject({ id: messageId, state: "rejected", reason: "provider_session_unavailable" });
    expect(cli.transcript()).toHaveLength(0);
    // Two attempts: the fenced unknown one, and the refusal that resolved it.
    expect(second.built.sessionInputs!.attempts(messageId).map((a) => a.outcome)).toEqual(["unknown", "rejected"]);
  });

  it("never pushes into a CLI whose provider session the kernel does not recognise", async () => {
    const sessionId = `run_live_${Math.random().toString(36).slice(2, 8)}`;
    // The live process belongs to a DIFFERENT provider session than the one the
    // kernel recorded for this run: the adapter must not write into it.
    const cli = new LiveCli("provider-someone-else");
    const ws = track(boot(home, { adapters: resolver(sessionId, cli) }));
    seedSession(ws.db, { sessionId, assistantId: "real-a" });

    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "cross-session leak" });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ state: "rejected", reason: "provider_session_mismatch" });
    expect(cli.received).toHaveLength(0);
    expect(cli.transcript()).toHaveLength(0);
  });
});

describe("session-input capability manifest", () => {
  /** Asks the manifest route what this session can actually do right now. */
  async function capability(ws: Workspace, sessionId: string): Promise<Record<string, unknown>> {
    const res = await ws.built.app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/input-capability`,
      headers: ws.headers,
    });
    return res.json();
  }

  it("reports Claude Code available only while its CLI is actually running", async () => {
    const { ws, cli, sessionId } = liveWorkspace();

    await expect(capability(ws, sessionId)).resolves.toMatchObject({
      available: true,
      assistantId: "real-a",
      capabilityVersion: "claude-code-session-input/1",
      ackLevel: "provider-accepted",
      // The two facts that make ambiguity resolvable exactly one way here.
      idempotentSend: false,
      receiptLookup: true,
      policy: "dispatch",
    });

    // Same session, same configuration, no process: the manifest changes with
    // the world rather than repeating what the config hoped for.
    cli.alive = false;
    await expect(capability(ws, sessionId)).resolves.toMatchObject({
      available: false,
      reason: "no_live_provider_session",
    });
  });

  it("reports a session on another assistant as unsupported, never as the fake", async () => {
    const { ws } = liveWorkspace();
    const { sessionId } = seedSession(ws.db, { assistantId: "codex-a" });

    await expect(capability(ws, sessionId)).resolves.toEqual({
      available: false,
      reason: "adapter_input_unsupported",
      assistantId: "codex-a",
    });
    // And it is refused on the send path too — not silently routed anywhere.
    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "hi" });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ state: "rejected", reason: "adapter_input_unsupported" });
  });

  it("resolves the real Claude adapter through the production wiring, with no live run", async () => {
    // No injected resolver: this is the server's own assistant -> adapter path.
    const ws = track(boot(home));
    const { sessionId } = seedSession(ws.db, { assistantId: "real-a" });

    // The live adapter IS wired for an anthropic assistant — and truthfully
    // reports that this session has no process, rather than falling back to
    // the deterministic adapter or claiming a capability it cannot honour.
    await expect(capability(ws, sessionId)).resolves.toMatchObject({
      available: false,
      reason: "no_live_provider_session",
      capabilityVersion: "claude-code-session-input/1",
    });
    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "hello" });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ state: "rejected", reason: "provider_session_unavailable" });
  });

  it("is not registered at all while the flag is off", async () => {
    const ws = track(boot(home, { sessionInput: false }));
    const { sessionId } = seedSession(ws.db, { assistantId: "real-a" });
    const res = await ws.built.app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/input-capability`,
      headers: ws.headers,
    });
    expect(res.statusCode).toBe(404);
    expect(ws.built.sessionInputs).toBeUndefined();
  });
});
