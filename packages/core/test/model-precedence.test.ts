import { describe, expect, it } from "vitest";
import { MODEL_PRECEDENCE, pickModel, type ModelPrecedenceInputs } from "../src/model-precedence.js";

describe("pickModel (decision D2: one model order, the task's override first)", () => {
  const values = { "task-override": "t", "stage-override": "s", "k13-applied": "k", default: "d" } as const;
  // Every subset of the four sources.
  const subsets = Array.from({ length: 16 }, (_, mask) =>
    Object.fromEntries(MODEL_PRECEDENCE.filter((_, i) => mask & (1 << i)).map((s) => [s, values[s]])) as ModelPrecedenceInputs);

  it.each(subsets)("%o picks the highest-ranked source present", (inputs) => {
    const first = MODEL_PRECEDENCE.find((s) => inputs[s] !== undefined);
    const picked = pickModel(inputs);
    if (!first) return expect(picked).toBeUndefined();
    expect(picked).toEqual({
      id: values[first], source: first,
      outranked: MODEL_PRECEDENCE.filter((s) => s !== first && inputs[s] !== undefined).map((s) => ({ source: s, id: values[s] })),
    });
  });

  it("an empty selector takes no part, and a lower source naming the same model is not outranked", () => {
    expect(pickModel({ "task-override": "", "stage-override": "m", default: "m" })).toEqual({ id: "m", source: "stage-override", outranked: [] });
  });

  it("the order is the one the composer and the launch both document", () => {
    expect(MODEL_PRECEDENCE).toEqual(["task-override", "stage-override", "k13-applied", "default"]);
  });
});
