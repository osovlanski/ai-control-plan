/**
 * §4 determinism property: equal inputs give byte-identical canonical JSON, whatever the clock,
 * the TZ and the process cwd. Inputs are generated from a seeded PRNG so a failure reproduces.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  jcs, runComposer, type ComposerAsset, type ComposerInputs, type ComposerOverrides, type HarnessModelProjection,
} from "../../src/index.js";
import { baseInputs, checkDecision, checkSpec, clone, deps, digestOf, fakeBundle, fakeHarnessModel, projection, skill, type RenderPlan } from "./helpers.js";

const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string; chdir(dir: string): void } }).process;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Variant { inputs: ComposerInputs; harness: HarnessModelProjection; plans: RenderPlan[] }

function variant(seed: number): Variant {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const some = <T>(xs: readonly T[]): T[] => xs.filter(() => rnd() < 0.5);
  const TAGS = ["coding", "review", "typescript", "fastify", "content", "vitest", "node"];
  const pool: ComposerAsset[] = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((name) =>
    skill(name, {
      tags: some(TAGS).sort(),
      kind: rnd() < 0.15 ? "mcp_server" : "skill",
      enabled: rnd() > 0.1,
      conflicts: rnd() < 0.2 ? ["claude-skills:alpha"] : [],
      requirements: { secretRefs: rnd() < 0.2 ? [{ type: "env", name: "EXAMPLE_ENV_NAME" }] : [] },
    }));
  const assets = some(pool);
  const allowlist = some(assets).map(({ id, digest }) => ({ id, digest }));
  const optIns = some(assets.filter((a) => !allowlist.some((x) => x.id === a.id))).map((a) => ({
    assetId: a.id, digest: rnd() < 0.7 ? a.digest : digestOf("stale"), actor: "operator", at: "2026-10-18T08:05:00.000Z",
  }));
  const base = baseInputs();
  const overrides: ComposerOverrides | undefined = pick<ComposerOverrides | undefined>([
    undefined, undefined,
    { intent: { kind: "review" } },
    { assets: { remove: assets.map((a) => a.id).slice(0, 1) } },
    { policy: { permission: "read-only", budget: { max_tokens: 1000 } } },
    { context: { fragments: ["typescript-style"] } },
  ]);
  const registry: ComposerInputs["registry"] = rnd() < 0.1 ? { status: "off" } : { ...(base.registry as Extract<ComposerInputs["registry"], { status: "ok" }>), stale: rnd() < 0.2, assets };
  const inputs: ComposerInputs = {
    ...base,
    task: {
      id: `AG-${seed}`,
      goal: pick(["Fix the flaky retry test", "Review the parser and deploy it", "why is it slow", "tidy the docs", "drop the old table"]),
      constraints: some(["keep the API", "never print a secret"]),
      ...(rnd() < 0.8 ? { storedKind: pick(["coding", "review", "research", "general"] as const) } : {}),
    },
    repoSignals: rnd() < 0.2 ? { status: "unavailable", reason: "base_unreadable" } : base.repoSignals,
    registry,
    optIns,
    environment: { envNames: rnd() < 0.5 ? ["EXAMPLE_ENV_NAME"] : [], commands: [] },
    config: {
      ...base.config,
      maxSkills: Math.floor(rnd() * 4),
      allowlist,
      memoryBundles: rnd() < 0.5 ? [{ id: "mem-a", digest: digestOf("mem-a"), reason: "pinned" }] : [],
      charsPerToken: pick([3.5, 4, 2.75]),
      budget: { max_tokens: pick([20000, 200000]), max_runtime_ms: 1800000, ...(rnd() < 0.5 ? { max_cost_usd: 2.5 } : {}) },
    },
    consumed: { tokens: Math.floor(rnd() * 30000), costUsd: Math.round(rnd() * 100) / 100, costMethod: "estimated", unknownCostSessions: 0, sessions: 1, recordCount: 1 },
    confirm: rnd() < 0.5 ? { mode: "preview" } : { mode: "start", origin: pick(["operator", "wake", "failover"] as const) },
    ...(overrides ? { overrides } : {}),
  };
  const p = projection();
  const harness = rnd() < 0.1 ? projection({ chosen: undefined, ruleFired: "no-eligible-candidate" })
    : { ...p, chosen: { ...p.chosen!, harness: pick(["claude-code", "claude-code", "codex", "cursor"] as const), usageReporting: rnd() < 0.3 } };
  const excluded = assets.find(() => rnd() < 0.3);
  const plans: RenderPlan[] = excluded ? [{ excludeSkills: { [excluded.id]: "renderer said no" } }, {}] : [{}];
  return { inputs, harness, plans };
}

async function composeIn(v: Variant, env: { now: number; tz: string; cwd: string }) {
  vi.useFakeTimers({ now: env.now, toFake: ["Date"] });
  proc.env.TZ = env.tz;
  proc.chdir(env.cwd);
  try {
    const result = await runComposer(clone(v.inputs), { harnessModel: fakeHarnessModel(clone(v.harness)), bundle: fakeBundle(...clone(v.plans)) }, deps);
    return jcs(result, "finite");
  } finally {
    vi.useRealTimers();
  }
}

describe("determinism (§4)", () => {
  const original = { tz: proc.env.TZ, cwd: proc.cwd() };
  afterEach(() => {
    if (original.tz === undefined) delete proc.env.TZ; else proc.env.TZ = original.tz;
    proc.chdir(original.cwd);
  });
  const envs = [
    { now: 0, tz: "UTC", cwd: "/" },
    { now: Date.UTC(2031, 5, 15, 23, 59, 59), tz: "Asia/Kolkata", cwd: original.cwd },
    { now: Date.UTC(1999, 11, 31, 12), tz: "America/Los_Angeles", cwd: `${original.cwd}/test` },
  ];

  it.each(Array.from({ length: 60 }, (_, i) => i + 1))("seed %i: byte-identical across clocks, TZ and cwd", async (seed) => {
    const v = variant(seed);
    const before = jcs(v.inputs);
    const outputs = [];
    for (const env of envs) outputs.push(await composeIn(v, env));
    expect(new Set(outputs).size).toBe(1);
    expect(jcs(v.inputs)).toBe(before);
    const result = JSON.parse(outputs[0]!) as Awaited<ReturnType<typeof runComposer>>;
    expect(checkDecision(result.decision)).toEqual([]);
    if (result.specDraft) expect(checkSpec(result.specDraft, result.decision, result.bundle)).toEqual([]);
    expect(outputs[0]).not.toMatch(/fixture-host|\/home\/|2031|1999/);
  });

  it("the generated cases reach every outcome", async () => {
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const v = variant(seed);
      const r = await runComposer(v.inputs, { harnessModel: fakeHarnessModel(v.harness), bundle: fakeBundle(...v.plans) }, deps);
      outcomes.add(r.outcome.status === "composed" ? "composed" : `${r.outcome.status}:${r.outcome.reason}`);
    }
    expect([...outcomes].sort()).toEqual(expect.arrayContaining(["composed", "failed:no_candidate", "skipped:unsupported_harness"]));
  });
});
