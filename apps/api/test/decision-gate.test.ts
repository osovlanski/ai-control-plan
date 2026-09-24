/**
 * M16 K19c — the tool gate's activation precondition (I-D8), its per-run
 * prompt rate (§8), and the config that requests it (§7.4).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionProvider, DecisionRequest } from "@agent-plane/core";
import { TOOL_GATE_JUDGED_KEYS } from "@agent-plane/core";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { CheckpointService } from "../src/modules/checkpoint.js";
import { DecisionService, insertDecisionRecord, listDecisions, toolGatePromptRates } from "../src/modules/decision.js";
import { buildHarnessComposition } from "../src/modules/harness/composition.js";
import { Registry } from "../src/modules/registry.js";
import { TaskEventBus } from "../src/modules/sse.js";
import { TaskStore } from "../src/modules/tasks.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "decision-gate-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  for (const id of ["run-1", "run-2"]) {
    db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES (?, 'AG-1','a1','ACTIVE','t')").run(id);
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const judge = (judged: readonly string[] = TOOL_GATE_JUDGED_KEYS, id: DecisionProvider["id"] = "model"): DecisionProvider => ({
  id,
  describe: () => ({ reachable: true, egress: "local", judges: { "tool-gate": judged } }),
  decide: async () => ({ answers: {}, provider: id, latencyMs: 0 }),
});

describe("I-D8 — the gate refuses `applied` without a judging provider", () => {
  it("rules only: applied is REFUSED, the site stays in shadow, and the refusal names the site and why", () => {
    const got = new DecisionService({ provider: "rules" }).activation("tool-gate", "applied");
    expect(got.mode).toBe("shadow");
    expect(got.refusal).toMatch(/decisions\.sites\.tool-gate\.mode: applied REFUSED/);
    expect(got.refusal).toMatch(/every rules-allowed tool call would prompt/);
  });

  it("a judge that covers every judged key, in the configured chain: applied is granted", () => {
    expect(new DecisionService({ provider: "model" }, [judge()]).activation("tool-gate", "applied")).toEqual({ mode: "applied" });
  });

  it("a registered judge OUTSIDE the configured chain does not count (provider: rules never reaches it)", () => {
    expect(new DecisionService({ provider: "rules" }, [judge()]).activation("tool-gate", "applied").mode).toBe("shadow");
  });

  it("a judge missing one judged key does not count", () => {
    const partial = judge(TOOL_GATE_JUDGED_KEYS.filter((k) => k !== "credential_reach"));
    expect(new DecisionService({ provider: "model" }, [partial]).activation("tool-gate", "applied").mode).toBe("shadow");
  });

  it("shadow is never refused", () => {
    expect(new DecisionService({ provider: "rules" }).activation("tool-gate", "shadow")).toEqual({ mode: "shadow" });
  });

  it("composition: a workspace configured `applied` with no judge runs the gate in shadow and warns out loud", () => {
    const home = join(dir, "home");
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    config.decisions.sites["tool-gate"].mode = "applied";
    const warnings: string[] = [];
    const tasks = new TaskStore(db);
    const composed = buildHarnessComposition({
      db,
      config,
      tasks,
      bus: new TaskEventBus(),
      checkpoints: new CheckpointService(db, tasks),
      registry: new Registry(db, config),
      onError: () => {},
      onWarning: (m) => warnings.push(m),
    });
    expect(composed.toolGateMode).toBe("shadow");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/tool-gate\.mode: applied REFUSED/);
  });

  it("composition (K19i, I-D2): §7.4's old example `provider: typesafe` fails at startup instead of prompting on every call", () => {
    const config = loadConfig({ AGENT_PLANE_HOME: join(dir, "home-k19i") });
    config.decisions.provider = "typesafe";
    const tasks = new TaskStore(db);
    expect(() =>
      buildHarnessComposition({
        db,
        config,
        tasks,
        bus: new TaskEventBus(),
        checkpoints: new CheckpointService(db, tasks),
        registry: new Registry(db, config),
        onError: () => {},
      }),
    ).toThrow(/decisions\.provider: "typesafe" is not registered in this build/);
  });

  it("composition (K19d): even with the build's judge reachable, applied stays closed until §7.4 attestations exist", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const config = loadConfig({ AGENT_PLANE_HOME: join(dir, "home-k19d") });
      config.decisions.provider = "model";
      config.decisions.sites["tool-gate"].mode = "applied";
      const warnings: string[] = [];
      const tasks = new TaskStore(db);
      const composed = buildHarnessComposition({
        db,
        config,
        tasks,
        bus: new TaskEventBus(),
        checkpoints: new CheckpointService(db, tasks),
        registry: new Registry(db, config),
        onError: () => {},
        onWarning: (m) => warnings.push(m),
      });
      expect(composed.toolGateMode).toBe("shadow");
      expect(warnings).toEqual([expect.stringMatching(/§7\.4 activation attestations are not implemented/)]);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe("§8 — prompt rate per run", () => {
  const req: DecisionRequest = { site: "tool-gate", state: {}, questions: {}, budgetMs: 50 };
  const row = (sessionId: string, outcome: "prompt" | "auto-approve", reason: string) =>
    insertDecisionRecord(
      db,
      req,
      { answers: {}, provider: "rules", latencyMs: 0 },
      { taskId: "AG-1", sessionId, mode: "shadow", gate: { outcome, reason, hook: "pre-exec", tier: "preventive" } },
      "2026-09-22T00:00:00.000Z",
    );

  it("is prompts / evaluations per session, from the gate rows alone", () => {
    row("run-1", "prompt", "no basis (answer absent): risk");
    row("run-1", "auto-approve", "judged: risk=low");
    row("run-1", "prompt", "judged: risk=high");
    row("run-2", "auto-approve", "judged: risk=none");
    // A pre-K19c row (no gate columns) is not an evaluation the gate made.
    insertDecisionRecord(db, req, { answers: {}, provider: "rules", latencyMs: 0 }, { sessionId: "run-2", mode: "shadow" }, "t");

    const rates = toolGatePromptRates(db);
    expect(rates.find((r) => r.sessionId === "run-1")).toMatchObject({ evaluations: 3, prompts: 2, promptRate: 2 / 3, mode: "shadow" });
    expect(rates.find((r) => r.sessionId === "run-2")).toMatchObject({ evaluations: 1, prompts: 0, promptRate: 0 });
  });

  it("the gate columns read back, and absence reads differently from a measured low", () => {
    row("run-1", "prompt", "no basis (answer absent): risk");
    row("run-1", "auto-approve", "judged: risk=low");
    const [low, absent] = listDecisions(db);
    expect(absent).toMatchObject({ gateOutcome: "prompt", gateReason: "no basis (answer absent): risk", gateHook: "pre-exec", gateTier: "preventive" });
    expect(low).toMatchObject({ gateOutcome: "auto-approve", gateReason: "judged: risk=low" });
  });
});

describe("§7.4 config — decisions.sites.tool-gate.mode", () => {
  const withYaml = (yaml: string) => {
    const home = join(dir, "cfg");
    loadConfig({ AGENT_PLANE_HOME: home }); // scaffold
    const path = join(home, "personal", "config.yaml");
    writeFileSync(path, yaml);
    return () => loadConfig({ AGENT_PLANE_HOME: home });
  };

  it("defaults to shadow", () => {
    expect(loadConfig({ AGENT_PLANE_HOME: join(dir, "d") }).decisions.sites["tool-gate"].mode).toBe("shadow");
  });

  it("rejects a value that is neither shadow nor applied", () => {
    const load = withYaml("decisions:\n  sites:\n    tool-gate:\n      mode: on\n");
    expect(load).toThrow(/decisions\.sites\.tool-gate\.mode must be shadow \| applied/);
  });
});
