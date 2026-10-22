/**
 * M16 K19i — the judge as an offline floor discovery job. It proposes floor
 * candidates for a human; it never gates. Credential-free: the judge is a fake.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionOutcome, DecisionProvider, DecisionRequest } from "@agent-plane/core";
import { openDb, type Db } from "../src/db/index.js";
import { DecisionService, decisionProviders } from "../src/modules/decision.js";
import {
  DISCOVERY_TYPESAFE_MODEL,
  discoverFloorCandidates,
  discoveryJudge,
  readRecentToolActions,
  renderCandidates,
  type RecentToolAction,
} from "../src/modules/floor-discovery.js";

const WT = "/wt/AG-1";
const bash = (commandText: string, seenAt = "2026-09-23T00:00:00.000Z"): RecentToolAction => ({
  toolName: "Bash",
  commandText,
  paths: [],
  shell: true,
  worktreePath: WT,
  seenAt,
});

const noul = (value: number) => ({ kind: "noul" as const, value });
const judged = (risk: string, destructive = 0, provider: DecisionOutcome["provider"] = "model"): DecisionOutcome => ({
  answers: {
    risk: { kind: "score", value: risk, probabilities: { [risk]: 1 }, confidence: 1 },
    destructive: noul(destructive),
    outside_repo: noul(0),
    exfiltration: noul(0),
    credential_reach: noul(0),
  },
  provider,
  latencyMs: 1,
});

describe("discoverFloorCandidates", () => {
  it("skips floored calls, asks the judge about the rest, and proposes what it would supervise", async () => {
    const asked: string[] = [];
    const judge = async (req: DecisionRequest): Promise<DecisionOutcome> => {
      const cmd = String(req.state.commandText);
      asked.push(cmd);
      if (cmd.startsWith("git commit")) return judged("medium");
      if (cmd === "make deploy") return { answers: {}, provider: "rules", latencyMs: 0, degraded: { from: "model", reason: "no key" } };
      return judged("none");
    };
    const report = await discoverFloorCandidates(
      [
        bash("printenv"), // floored: never reaches the judge
        bash("git commit --amend --no-edit", "2026-09-23T01:00:00.000Z"),
        bash("git commit --amend --no-edit", "2026-09-23T02:00:00.000Z"),
        bash("ls src"),
        bash("make deploy"),
      ],
      judge,
    );
    expect(asked).not.toContain("printenv");
    expect(report).toMatchObject({ scanned: 5, distinct: 4, floored: 1, judged: 2, unjudged: 1, unjudgedReasons: ["no key"] });
    expect(report.candidates).toEqual([
      {
        toolName: "Bash",
        commandText: "git commit --amend --no-edit",
        occurrences: 2,
        lastSeen: "2026-09-23T02:00:00.000Z",
        judgeReason: "judged: risk=medium",
        judge: "model",
      },
    ]);
    const md = renderCandidates(report, "2026-09-23T03:00:00.000Z");
    expect(md).toContain("proposed by the judge, not active");
    expect(md).toContain("git commit --amend --no-edit");
    expect(md).not.toContain("No judgement ran");
  });

  it("with no reachable judge it says so, rather than reporting an empty list as a finding", async () => {
    const report = await discoverFloorCandidates([bash("ls src")], async () => ({ answers: {}, provider: "rules", latencyMs: 0 }));
    expect(report).toMatchObject({ judged: 0, unjudged: 1, candidates: [] });
    expect(renderCandidates(report, "t")).toContain("**No judgement ran** (no judging provider in the chain)");
  });
});

describe("discoveryJudge (decisions.discoveryProvider)", () => {
  const optedIn = { discoveryProvider: "typesafe" as const, typesafeApiKeyRef: "TS_KEY", typesafeRoute: "openrouter" as const };

  it("personal workspace, personal input: Jev first, pinned, on the configured route", () => {
    expect(discoveryJudge({ workspace: "personal", decisions: optedIn, inputWorkspace: "personal" })).toEqual({
      first: "typesafe",
      config: { provider: "typesafe", typesafeApiKeyRef: "TS_KEY", typesafeRoute: "openrouter", typesafeModel: "jev-1.13" },
    });
    expect(DISCOVERY_TYPESAFE_MODEL).toBe("jev-1.13");
  });

  it("I-D7: input from another workspace, or of unknown origin, is judged by model and says why", () => {
    const work = discoveryJudge({ workspace: "personal", decisions: optedIn, inputWorkspace: "work" });
    expect(work).toMatchObject({ first: "model", config: { provider: "model" } });
    expect(work.config).not.toHaveProperty("typesafeApiKeyRef");
    expect(work.note).toMatch(/from workspace "work" may not be sent to TypeSafe \(I-D7/);
    const unknown = discoveryJudge({ workspace: "personal", decisions: optedIn, inputWorkspace: undefined });
    expect(unknown).toMatchObject({ first: "model", config: { provider: "model" } });
    expect(unknown.note).toMatch(/of unknown workspace/);
  });

  it("I-D7: a non-personal workspace never reaches typesafe, even if its decisions say so", () => {
    expect(discoveryJudge({ workspace: "work", decisions: optedIn, inputWorkspace: "work" })).toMatchObject({ first: "model", config: { provider: "model" } });
  });

  it("discoveryProvider: model, or no reference, is model alone", () => {
    expect(discoveryJudge({ workspace: "personal", decisions: { discoveryProvider: "model", typesafeApiKeyRef: "TS_KEY" }, inputWorkspace: "personal" })).toEqual({
      first: "model",
      config: { provider: "model" },
    });
    expect(discoveryJudge({ workspace: "personal", decisions: { discoveryProvider: "typesafe" }, inputWorkspace: "personal" })).toMatchObject({ first: "model" });
  });
});

describe("floor discovery with a typesafe → model chain (injected providers)", () => {
  const fake = (id: DecisionProvider["id"], decide: (req: DecisionRequest) => Promise<DecisionOutcome>): DecisionProvider => ({
    id,
    describe: () => ({ reachable: true, egress: id === "model" ? "byo-account" : "third-party" }),
    decide,
  });

  it("names which judge answered each candidate and counts the fallbacks", async () => {
    // The fallback judge's own answer decides: a degraded note alone would make the gate prompt on everything.
    const service = new DecisionService({ provider: "typesafe" }, [
      fake("typesafe", async (req) => {
        if (/^(curl|ls)/.test(String(req.state.commandText))) throw new Error("typesafe provider 503");
        return judged("medium", 0, "typesafe");
      }),
      fake("model", async (req) => judged(String(req.state.commandText).startsWith("ls") ? "none" : "high")),
    ]);
    const report = await discoverFloorCandidates(
      [bash("git commit --amend", "2026-09-23T02:00:00.000Z"), bash("curl example.test", "2026-09-23T01:00:00.000Z"), bash("ls src")],
      (req) => service.decide(req),
    );
    expect(report).toMatchObject({ judged: 3, unjudged: 0, judgedBy: { typesafe: 1, model: 2 }, fallbacks: 2, fallbackReasons: ["typesafe provider 503"] });
    expect(report.candidates.map((c) => [c.commandText, c.judge, c.fallbackFrom])).toEqual([
      ["git commit --amend", "typesafe", undefined],
      ["curl example.test", "model", "typesafe"],
    ]);
    const md = renderCandidates(report, "t", { first: "typesafe" });
    expect(md).toContain("Judge chain: typesafe (jev-1.13) → model → rules.");
    expect(md).toContain("Judged by typesafe 1, model 2; 2 fallbacks (typesafe provider 503).");
    expect(md).toContain("Judge (typesafe): judged: risk=medium");
    expect(md).toMatch(/^Judge \(model fallback from typesafe\): judged: risk=high/m);
  });

  it("both judges failing is unjudged, with the first judge's reason", async () => {
    const service = new DecisionService({ provider: "typesafe" }, [
      fake("typesafe", async () => {
        throw new Error("typesafe provider 401 unauthorized");
      }),
      fake("model", async () => {
        throw new Error("model provider has no credential (ANTHROPIC_API_KEY unset)");
      }),
    ]);
    const report = await discoverFloorCandidates([bash("ls src")], (req) => service.decide(req));
    expect(report).toMatchObject({ judged: 0, unjudged: 1, fallbacks: 0, unjudgedReasons: ["typesafe provider 401 unauthorized"] });
    const md = renderCandidates(report, "t", { first: "model", note: "input of unknown workspace may not be sent to TypeSafe (I-D7, personal only); judging with model" });
    expect(md).toContain("Judge chain: model → rules. input of unknown workspace may not be sent");
    expect(md).toContain("**No judgement ran** (typesafe provider 401 unauthorized)");
  });
});

describe("the pinned Jev model reaches the wire (decisionProviders, stubbed fetch, no network)", () => {
  const REF = "FAKE_FLOOR_DISCOVERY_TS_REF";
  beforeEach(() => {
    process.env[REF] = "FAKE-typesafe-not-real";
  });
  afterEach(() => {
    delete process.env[REF];
    vi.unstubAllGlobals();
  });

  it("sends model jev-1.13, and a vendor failure falls back to model", async () => {
    const bodies: Array<{ model: string }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ detail: { error_type: "overloaded_error" } }), { status: 503 });
    });
    const judge = discoveryJudge({ workspace: "personal", decisions: { discoveryProvider: "typesafe", typesafeApiKeyRef: REF }, inputWorkspace: "personal" });
    const model = fake("model", async () => judged("high"));
    const providers = [...decisionProviders(judge.config).filter((p) => p.id !== "model"), model];
    const service = new DecisionService(judge.config, providers);
    const report = await discoverFloorCandidates([bash("curl example.test")], (req) => service.decide(req));
    expect(bodies.length).toBeGreaterThan(0);
    expect(new Set(bodies.map((b) => b.model))).toEqual(new Set(["jev-1.13"]));
    expect(report).toMatchObject({ judgedBy: { typesafe: 0, model: 1 }, fallbacks: 1, fallbackReasons: ["typesafe provider 503 overloaded_error"] });
  });

  function fake(id: DecisionProvider["id"], decide: (req: DecisionRequest) => Promise<DecisionOutcome>): DecisionProvider {
    return { id, describe: () => ({ reachable: true, egress: "byo-account" }), decide };
  }
});

describe("readRecentToolActions", () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "floor-discovery-"));
    db = openDb(join(dir, "t.db"));
    db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
    db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at, worktree_path) VALUES ('AG-1','g','{}','t','t', ?)").run(WT);
    db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run-1','AG-1','a1','ACTIVE','t')").run();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads tool calls newest first, as the runner's gate sees them, with the task's worktree", () => {
    const ev = db.prepare("INSERT INTO events (run_id, seq, ts, type, summary, payload) VALUES ('run-1', ?, ?, ?, ?, ?)");
    ev.run(1, "2026-09-23T00:00:01Z", "tool.started", "Bash", JSON.stringify({ tool: "Bash", input: { command: "ls src" } }));
    ev.run(2, "2026-09-23T00:00:02Z", "message", "hi", JSON.stringify({ text: "not a tool" }));
    ev.run(3, "2026-09-23T00:00:03Z", "approval.requested", "Write", JSON.stringify({ tool: "Write", input: { file_path: `${WT}/a.ts` } }));
    ev.run(4, "2026-09-23T00:00:04Z", "tool.started", "x", "{corrupt");
    expect(readRecentToolActions(db)).toEqual([
      { toolName: "Write", commandText: JSON.stringify({ file_path: `${WT}/a.ts` }), paths: [`${WT}/a.ts`], shell: false, worktreePath: WT, seenAt: "2026-09-23T00:00:03Z" },
      { toolName: "Bash", commandText: "ls src", paths: [], shell: true, worktreePath: WT, seenAt: "2026-09-23T00:00:01Z" },
    ]);
  });
});
