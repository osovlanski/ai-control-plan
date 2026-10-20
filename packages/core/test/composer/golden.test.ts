/**
 * Golden fixture (§4 Tests): a fixed input file gives a pinned decision, spec draft and digest.
 * The input holds the port answers too, so the result depends on nothing outside these files.
 * apps/api (S4) validates `golden.result.json` against the composition schemas.
 *
 * After an intended change, regenerate with `UPDATE_GOLDEN=1 pnpm --filter @agent-plane/core test`
 * and review the diff of `fixtures/golden.result.json` before committing it.
 */
import { describe, expect, it } from "vitest";
import { jcs, runComposer, type BundlePortResult, type ComposerInputs, type HarnessModelProjection, type ProvisioningPrediction } from "../../src/index.js";
import golden from "./fixtures/golden.input.json";
import pinned from "./fixtures/golden.result.json";
import { checkDecision, checkSpec, deps, clone } from "./helpers.js";

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const fixture = golden as unknown as { inputs: ComposerInputs; harnessModel: HarnessModelProjection; bundleAnswers: BundlePortResult[]; provisioningAnswer: ProvisioningPrediction };

async function composeGolden() {
  const answers = clone(fixture.bundleAnswers);
  const drafts: unknown[] = [];
  const result = await runComposer(clone(fixture.inputs), {
    harnessModel: { select: async () => clone(fixture.harnessModel) },
    bundle: {
      render: async (draft) => {
        drafts.push(clone(draft));
        const answer = answers.shift();
        if (!answer) throw new Error("golden: more renders than answers");
        return answer;
      },
    },
    provisioning: { predict: async () => clone(fixture.provisioningAnswer) },
  }, deps);
  return { result, drafts, unused: answers.length };
}

describe("golden fixture", () => {
  it("pins the decision, spec draft, digest and outcome", async () => {
    const { result, unused } = await composeGolden();
    expect(unused).toBe(0);
    if (env.UPDATE_GOLDEN === "1") {
      const fs = (await import("node:" + "fs")) as { writeFileSync(path: URL, data: string): void };
      const body = { outcome: result.outcome, compositionDigest: result.compositionDigest, decision: result.decision, specDraft: result.specDraft };
      fs.writeFileSync(new URL("./fixtures/golden.result.json", import.meta.url), `${JSON.stringify(body, null, 2)}\n`);
      return;
    }
    expect(jcs(result.decision)).toBe(jcs(pinned.decision));
    expect(jcs(result.specDraft)).toBe(jcs(pinned.specDraft));
    expect(result.compositionDigest).toBe(pinned.compositionDigest);
    expect(result.outcome).toEqual(pinned.outcome);
  });

  it("is structurally valid, and each render asked for what the replayed answer rendered", async () => {
    const { result, drafts } = await composeGolden();
    expect(checkDecision(result.decision)).toEqual([]);
    expect(checkSpec(result.specDraft!, result.decision, result.bundle)).toEqual([]);
    const skillsOf = (d: unknown) => (d as { assets: { skills: Array<{ id: string; digest: string }> } }).assets.skills.map((s) => `${s.id}@${s.digest}`);
    const pinsOf = (a: BundlePortResult) => a.status === "failure" ? [] : a.response.manifest.included.concat(a.response.manifest.excluded.map((e) => ({ ...e, digest: "" }))).filter((e) => e.kind === "skill").map((e) => e.ref).sort();
    expect(drafts.map((d) => skillsOf(d).map((s) => s.split("@")[0]))).toEqual(fixture.bundleAnswers.map(pinsOf));
  });
});
