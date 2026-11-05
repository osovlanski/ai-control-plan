/**
 * O6 S5 (docs/agentic-os-o6-memory-writeback.md §2.3, §5 row S5): a settled composed session that
 * ended success proposes the memories in its last message's `agent-plane-memory` block, once; the
 * feed `GET /api/memory/proposals` (memory.read, memory v1) serves them. Nothing writes memory.
 * Every secret here is FAKE-*-not-real.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { COMMAND_CAPABILITIES, INGEST_CAPABILITIES, OBSERVABILITY_CAPABILITIES, type AgentAdapter } from "@agent-plane/core";
import { parseMemoryMarker } from "@agent-plane/adapters";
import { atomicWriteCredential, credentialPath, readCredential } from "../src/auth/credential-file.js";
import { computeMemoryProposalId, validateMemoryProposalPage, type MemoryProposalPage } from "../src/memory-contract.js";
import { changedFilesOf, MemoryProposals, parseMemoryFeedQuery } from "../src/modules/memory-proposals.js";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const GOAL = "Add a typed helper to the TypeScript parser module";
const entry = (over: Record<string, unknown> = {}) => ({ kind: "gotcha", name: "close-rig-in-aftereach", description: "Close the test rig in afterEach", body: "Vitest teardown flakes when a rig is not closed in afterEach.\n", ...over });
const marker = (entries: unknown) => `[FAKE:MEMORY:${JSON.stringify(entries)}]`;

async function runComposed(goal: string) {
  const taskId = rig!.built.tasks.create({ goal, repoPath: rig!.repo }).taskId;
  const done = reaches(rig!.built, taskId, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT", "WAITING_RESOURCE"]);
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  const state = await done;
  const sessionId = (rig!.db.prepare("SELECT id FROM runs WHERE task_id = ? ORDER BY started_at, rowid LIMIT 1").get(taskId) as { id: string }).id;
  return { taskId, state, sessionId };
}

type Row = Record<string, unknown>;
const rowsOf = (sessionId: string) => rig!.db.prepare("SELECT * FROM memory_proposals WHERE session_id = ? ORDER BY ingest_seq").all(sessionId) as Row[];
const ledgerOf = (sessionId: string) => rig!.db.prepare("SELECT * FROM memory_proposal_sessions WHERE session_id = ?").get(sessionId) as Row | undefined;
const count = (table: string) => (rig!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function credentialWith(capabilities: readonly string[]): { authorization: string } {
  const path = credentialPath(rig!.config.dir);
  const file = readCredential(path);
  const next = { kid: `k_${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities: [...capabilities], createdAt: new Date().toISOString(), notAfter: null };
  file.secrets.push(next);
  atomicWriteCredential(path, file);
  return { authorization: `Bearer ${next.secret}` };
}

async function feed(query = "", headers: Record<string, string> = rig!.auth()) {
  const res = await rig!.built.app.inject({ method: "GET", url: `/api/memory/proposals${query}`, headers });
  return { status: res.statusCode, body: res.json() as MemoryProposalPage & { error?: string } };
}

describe("memory proposals at settle", () => {
  it("a composed success run proposes its block's entries once; the feed serves memory v1 and a replay writes nothing", async () => {
    rig = await bootRig();
    const { state, sessionId, taskId } = await runComposed(`${GOAL} ${marker([entry(), entry({ kind: "fact", name: "second-fact", description: "Another fact", body: "Facts are immutable.\n" })])}`);
    expect(state).toBe("COMPLETED");
    const rows = rowsOf(sessionId);
    expect(rows.map((r) => [r.entry_index, r.kind, r.name])).toEqual([[0, "gotcha", "close-rig-in-aftereach"], [1, "fact", "second-fact"]]);
    const checkpoint = rig.db.prepare("SELECT id, at, reason FROM checkpoints WHERE session_id = ? AND reason = 'completion'").get(sessionId) as { id: string; at: string };
    for (const r of rows) expect(r).toMatchObject({ task_id: taskId, checkpoint_id: checkpoint.id, at: checkpoint.at, harness: "claude-code", outcome: "success", target_bundle_id: null, supersedes_json: "[]" });
    expect(rows[0]!.proposal_id).toBe(computeMemoryProposalId(sessionId, 0, entry().body));
    expect(ledgerOf(sessionId)).toMatchObject({ status: "proposed", proposals: 2, dropped_json: "{}", truncated: 0 });

    const page = await feed();
    expect(page.status).toBe(200);
    expect(validateMemoryProposalPage(page.body).ok).toBe(true);
    expect(page.body.events.map((e) => [e.seq, e.name, e.sessionId, e.evidence.outcome])).toEqual([[1, "close-rig-in-aftereach", sessionId, "success"], [2, "second-fact", sessionId, "success"]]);
    expect(page.body.next).toBe(2);

    const before = count("memory_proposals");
    expect(new MemoryProposals(rig.db).propose(sessionId)).toMatchObject({ status: "proposed", proposals: 2, inserted: 0, conflicts: 0 });
    expect(count("memory_proposals")).toBe(before);
    expect(() => rig!.db.prepare("UPDATE memory_proposals SET body = 'x'").run()).toThrow(/immutable/);
    expect(() => rig!.db.prepare("DELETE FROM memory_proposal_sessions").run()).toThrow(/immutable/);
  });

  it("a failed run with the marker proposes nothing", async () => {
    rig = await bootRig();
    const failed = await runComposed(`${GOAL} ${marker([entry()])} [FAKE:FAIL]`);
    // A provider fault parks the task for failover; the session itself settled FAILED.
    expect(failed.state).toBe("WAITING_RESOURCE");
    expect(rowsOf(failed.sessionId)).toEqual([]);
    expect(ledgerOf(failed.sessionId)).toMatchObject({ status: "skipped", skip_reason: "not_completion", proposals: 0 });
    expect(count("memory_proposals")).toBe(0);
  });

  it("a run without the marker is skipped no_block", async () => {
    rig = await bootRig();
    const plain = await runComposed(GOAL);
    expect(plain.state).toBe("COMPLETED");
    expect(ledgerOf(plain.sessionId)).toMatchObject({ status: "skipped", skip_reason: "no_block" });
    expect(count("memory_proposals")).toBe(0);
  });

  it("an ambient session proposes nothing", async () => {
    rig = await bootRig();
    (rig.built.registry.adapter("fake-claude") as AgentAdapter & Record<string, unknown>).prepare = undefined;
    const { state, sessionId } = await runComposed(`${GOAL} ${marker([entry()])}`);
    expect(state).toBe("COMPLETED");
    expect(rowsOf(sessionId)).toEqual([]);
    expect(ledgerOf(sessionId)).toMatchObject({ status: "skipped", skip_reason: "ambient" });
  });

  it("drops entries that carry a credential, an absolute path or a hostname, with counted reasons; truncates past five", async () => {
    rig = await bootRig();
    const entries = [
      entry({ name: "with-token", body: "Use sk-ant-FAKE-TOKEN-not-real-0123456789abcdef to call it." }),
      entry({ name: "with-path", body: "The repo lives at /home/operator/src/plane." }),
      entry({ name: "with-host", description: "Call build.corp.internal first" }),
      entry({ name: "clean-one" }),
      entry({ name: "clean-two", body: "Second clean body.\n" }),
      entry({ name: "sixth" }),
      entry({ name: "seventh" }),
    ];
    const { state, sessionId } = await runComposed(`${GOAL} ${marker(entries)}`);
    expect(state).toBe("COMPLETED");
    expect(rowsOf(sessionId).map((r) => [r.entry_index, r.name])).toEqual([[3, "clean-one"], [4, "clean-two"]]);
    const ledger = ledgerOf(sessionId)!;
    expect(ledger).toMatchObject({ status: "proposed", proposals: 2, truncated: 2 });
    const dropped = JSON.parse(ledger.dropped_json as string) as Record<string, number>;
    expect(Object.values(dropped).reduce((a, b) => a + b, 0)).toBe(3);
    expect(dropped.guard_absolute_path).toBe(1);
    expect(dropped.guard_hostname).toBe(1);
    // The token is either caught by the contract guard or was already redacted at persistence: dropped either way.
    expect((dropped.guard_credential ?? 0) + (dropped.redacted ?? 0)).toBe(1);
    const dump = JSON.stringify(rig.db.prepare("SELECT * FROM memory_proposals").all()) + JSON.stringify(rig.db.prepare("SELECT * FROM memory_proposal_sessions").all());
    expect(dump).not.toMatch(/FAKE|\/home\/operator|corp\.internal/);
  });

  it("a different body under a stored id is a counted conflict and the first row stays", async () => {
    rig = await bootRig();
    const { sessionId } = await runComposed(`${GOAL} ${marker([entry()])}`);
    // Stand in for an earlier parser: drop the triggers in this test DB only, change the stored digest.
    rig.db.exec("DROP TRIGGER memory_proposals_immutable");
    rig.db.prepare("UPDATE memory_proposals SET body_digest = 'sha256:older' WHERE session_id = ?").run(sessionId);
    const proposals = new MemoryProposals(rig.db);
    expect(proposals.propose(sessionId)).toMatchObject({ inserted: 0, conflicts: 1 });
    expect(proposals.conflicts).toBe(1);
    expect(rowsOf(sessionId)[0]!.body_digest).toBe("sha256:older");
  });

  it("boot backfill extracts a session settled before a simulated crash, and nothing twice", async () => {
    rig = await bootRig();
    rig.built.orchestrator.memoryProposals = undefined;
    const { sessionId } = await runComposed(`${GOAL} ${marker([entry()])}`);
    expect(ledgerOf(sessionId)).toBeUndefined();
    rig.built.orchestrator.memoryProposals = new MemoryProposals(rig.db);
    await rig.built.orchestrator.reconcileOnBoot();
    expect(rowsOf(sessionId)).toHaveLength(1);
    expect(new MemoryProposals(rig.db).backfill()).toEqual({ evaluated: 0, inserted: 0, conflicts: 0 });
    await rig.built.orchestrator.reconcileOnBoot();
    expect(rowsOf(sessionId)).toHaveLength(1);
  });

  it("targets a bundle only when the revision pinned it, at the pinned digest", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    rig = await bootRig({ configure: (c) => { c.composer.context.memoryBundles = [{ id: "plane-decisions", digest, reason: "pinned in test" }]; } });
    const { state, sessionId } = await runComposed(`${GOAL} ${marker([
      entry({ name: "targeted", targetBundle: "plane-decisions", supersedes: ["b.md", "a.md"] }),
      entry({ name: "unpinned", targetBundle: "someone-elses", supersedes: ["a.md"] }),
    ])}`);
    expect(state).toBe("COMPLETED");
    expect(rowsOf(sessionId).map((r) => [r.name, r.target_bundle_id, r.target_bundle_digest, r.supersedes_json])).toEqual([
      ["targeted", "plane-decisions", digest, '["a.md","b.md"]'],
      ["unpinned", null, null, "[]"],
    ]);
    expect(ledgerOf(sessionId)).toMatchObject({ untargeted: 1 });
    expect(validateMemoryProposalPage((await feed()).body).ok).toBe(true);
  });
});

describe("GET /api/memory/proposals", () => {
  it("pages by after without skipping or repeating; bounds are 400; no memory.read is 403; no credential is 401", async () => {
    rig = await bootRig();
    await runComposed(`${GOAL} ${marker([entry(), entry({ name: "b-fact" }), entry({ name: "c-fact" })])}`);
    const all = (await feed()).body.events.map((e) => e.proposalId);
    expect(all).toHaveLength(3);
    const seen: string[] = [];
    let cursor = 0;
    for (;;) {
      const page = await feed(`?after=${cursor}&limit=1`);
      expect(page.status).toBe(200);
      expect(validateMemoryProposalPage(page.body).ok).toBe(true);
      if (page.body.events.length === 0) { expect(page.body.next).toBe(cursor); break; }
      seen.push(...page.body.events.map((e) => e.proposalId));
      cursor = page.body.next;
    }
    expect(seen).toEqual(all);

    for (const q of ["?limit=0", "?limit=101", "?limit=abc", "?after=-1", "?after=1.5"]) expect((await feed(q)).status).toBe(400);
    expect((await feed("?limit=100")).status).toBe(200);

    const noMemory = credentialWith([...OBSERVABILITY_CAPABILITIES.filter((c) => c !== "memory.read"), ...COMMAND_CAPABILITIES, ...INGEST_CAPABILITIES]);
    expect((await feed("", noMemory)).status).toBe(403);
    expect((await feed("", credentialWith(["memory.read"]))).status).toBe(200);
    expect((await feed("", {})).status).toBe(401);
  });

  it("parseMemoryFeedQuery defaults and limits", () => {
    expect(parseMemoryFeedQuery(undefined)).toEqual({ ok: true, after: 0, limit: 100 });
    expect(parseMemoryFeedQuery({ after: "9007199254740991", limit: "1" })).toEqual({ ok: true, after: Number.MAX_SAFE_INTEGER, limit: 1 });
    expect(parseMemoryFeedQuery({ after: "9007199254740992" })).toMatchObject({ ok: false });
  });

  it("changedFilesOf reads git's diff --stat summary", () => {
    expect(changedFilesOf(" src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)")).toBe(1);
    expect(changedFilesOf(" 12 files changed, 3 insertions(+)")).toBe(12);
    expect(changedFilesOf(null)).toBe(0);
  });
});

describe("fake [FAKE:MEMORY:<json>] marker", () => {
  it("takes the JSON to its balanced close, brackets inside strings included", () => {
    expect(parseMemoryMarker('goal [FAKE:MEMORY:[{"body":"a ] b"}]] tail')).toBe('[{"body":"a ] b"}]');
    expect(parseMemoryMarker('[FAKE:MEMORY:[{"body":"esc \\" ]"}]]')).toBe('[{"body":"esc \\" ]"}]');
    expect(parseMemoryMarker("[FAKE:MEMORY:[1, 2")).toBeUndefined();
    expect(parseMemoryMarker("no marker")).toBeUndefined();
  });
});
