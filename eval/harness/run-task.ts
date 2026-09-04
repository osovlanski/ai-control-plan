/**
 * Drive one task through the real HTTP surface (bearer-authed `app.inject()`)
 * to a terminal state, then score it. Shared by every scenario so each one is
 * just "what goal, what fixture, what provider" (increment 3, plan §4).
 */
import type { BootedScenario } from "./boot.js";
import { scoreTask, type ScenarioScore } from "../scorer.js";

export interface RunTaskOptions {
  scenario: string;
  kind: "real" | "fake";
  provider?: string;
  goal: string;
  assistantId: string;
  repoPath?: string;
  /** Poll ceiling waiting for the task to leave RUNNING/ROUTING (ms). */
  timeoutMs?: number;
  /** Called once the task exists, before polling — e.g. to answer an approval. */
  onCreated?: (taskId: string) => Promise<void> | void;
}

const RESTING = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "WAITING_INPUT"]);

export async function runTaskToTerminal(booted: BootedScenario, opts: RunTaskOptions): Promise<ScenarioScore> {
  const { app } = booted.built;
  const created = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: booted.client.headers,
    payload: { goal: opts.goal, repoPath: opts.repoPath },
  });
  if (created.statusCode !== 201) {
    throw new Error(`${opts.scenario}: task creation failed (${created.statusCode}): ${created.body}`);
  }
  const taskId = (created.json() as { taskId: string }).taskId;

  const started = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/start`,
    headers: booted.client.headers,
    payload: { assistantId: opts.assistantId },
  });
  if (started.statusCode !== 200) {
    throw new Error(`${opts.scenario}: start failed (${started.statusCode}): ${started.body}`);
  }

  await opts.onCreated?.(taskId);

  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: booted.client.headers });
    const state = (res.json() as { state: string }).state;
    if (RESTING.has(state)) break;
    if (Date.now() > deadline) throw new Error(`${opts.scenario}: task ${taskId} did not settle within ${opts.timeoutMs ?? 30_000}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }

  return scoreTask(booted.db, { scenario: opts.scenario, kind: opts.kind, provider: opts.provider, taskId });
}
