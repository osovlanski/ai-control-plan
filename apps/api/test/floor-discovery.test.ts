/**
 * M16 K19i — the judge as an offline floor discovery job. It proposes floor
 * candidates for a human; it never gates. Credential-free: the judge is a fake.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionOutcome, DecisionRequest } from "@agent-plane/core";
import { openDb, type Db } from "../src/db/index.js";
import { discoverFloorCandidates, readRecentToolActions, renderCandidates, type RecentToolAction } from "../src/modules/floor-discovery.js";

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
const judged = (risk: string, destructive = 0): DecisionOutcome => ({
  answers: {
    risk: { kind: "score", value: risk, probabilities: { [risk]: 1 }, confidence: 1 },
    destructive: noul(destructive),
    outside_repo: noul(0),
    exfiltration: noul(0),
    credential_reach: noul(0),
  },
  provider: "model",
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
    expect(report).toMatchObject({ scanned: 5, distinct: 4, floored: 1, judged: 2, unjudged: 1 });
    expect(report.candidates).toEqual([
      {
        toolName: "Bash",
        commandText: "git commit --amend --no-edit",
        occurrences: 2,
        lastSeen: "2026-09-23T02:00:00.000Z",
        judgeReason: "judged: risk=medium",
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
    expect(renderCandidates(report, "t")).toContain("**No judgement ran**");
  });
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
