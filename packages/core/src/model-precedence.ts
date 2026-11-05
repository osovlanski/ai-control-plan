/**
 * Which model a task's run requests, in one order (decision D2, 2026-11-05: the task's own
 * override wins everywhere). The composer's stage 2 and the launch (`Orchestrator.requestedModel`)
 * both call `pickModel`, so a revision's `model.primary` and the run's `model_requested` come from
 * the same rule, and the why text names the source that won.
 *
 *  1. `task-override`  — the task's `intent.overrides.model`: the operator's hard intent;
 *  2. `stage-override` — an operator's stage-2 `harness_model.model` override for this composition;
 *  3. `k13-applied`    — a selector K13 committed in applied mode for the chosen assistant;
 *  4. `default`        — the manifest's first model (composer) or the bound revision's
 *                        `model.primary` (launch).
 *
 * Pure: no I/O, no clock. A source that is absent or empty does not take part.
 */
export const MODEL_PRECEDENCE = ["task-override", "stage-override", "k13-applied", "default"] as const;
export type ModelPrecedenceSource = (typeof MODEL_PRECEDENCE)[number];

export type ModelPrecedenceInputs = Partial<Record<ModelPrecedenceSource, string | undefined>>;

export interface ModelPick {
  id: string;
  source: ModelPrecedenceSource;
  /** Lower-ranked sources that named a DIFFERENT model, in precedence order: why they lost is the order. */
  outranked: Array<{ source: ModelPrecedenceSource; id: string }>;
}

export function pickModel(inputs: ModelPrecedenceInputs): ModelPick | undefined {
  const named = MODEL_PRECEDENCE.flatMap((source) => {
    const id = inputs[source];
    return typeof id === "string" && id.length > 0 ? [{ source, id }] : [];
  });
  const [winner, ...rest] = named;
  if (!winner) return undefined;
  return { id: winner.id, source: winner.source, outranked: rest.filter((r) => r.id !== winner.id) };
}
