/**
 * needs-approval (R8 fallback: FakeAdapter — plan §4 step 21). A real-provider
 * goal that reliably reaches an approval gate is not proven stable without
 * live credentials to validate it against, so this scenario runs against the
 * deterministic FakeAdapter for now (documented fallback, not a silent
 * downgrade — the real-provider assertion stays an area-1 flip precondition,
 * plan step 28). Proves: an approval-gated call blocks until `respondApproval`,
 * a denied call does not run — over the real HTTP + bearer-auth path.
 */
import { bootScenario } from "../harness/boot.js";
import type { ScenarioScore } from "../scorer.js";
import { scoreTask } from "../scorer.js";

export async function needsApproval(): Promise<ScenarioScore> {
  const booted = await bootScenario({
    extraConfigYaml: "assistants:\n  eval-fake:\n    provider: fake\n",
    harnessSingle: true,
  });
  const { app } = booted.built;
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: booted.client.headers,
      payload: { goal: "needs sign-off [FAKE:APPROVAL]" },
    });
    const taskId = (created.json() as { taskId: string }).taskId;
    const started = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/start`,
      headers: booted.client.headers,
      payload: { assistantId: "eval-fake" },
    });
    if (started.statusCode !== 200) throw new Error(`needs-approval: start failed (${started.statusCode})`);

    const deadline = Date.now() + 10_000;
    let requestId: string | undefined;
    while (!requestId) {
      const events = await app.inject({
        method: "GET",
        url: `/api/tasks/${taskId}/events`,
        headers: booted.client.headers,
      });
      const found = (events.json() as Array<{ type: string; payload?: { requestId?: string } }>).find(
        (e) => e.type === "approval.requested",
      );
      requestId = found?.payload?.requestId;
      if (!requestId) {
        if (Date.now() > deadline) throw new Error("needs-approval: no approval.requested event within 10s");
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    // Blocked-until-answered: confirm the task is still not terminal here.
    const midFlight = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: booted.client.headers });
    const midState = (midFlight.json() as { state: string }).state;
    if (midState !== "RUNNING" && midState !== "WAITING_INPUT") {
      throw new Error(`needs-approval: task settled to ${midState} before an approval decision was made`);
    }

    const denied = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/input`,
      headers: booted.client.headers,
      payload: { kind: "approval", requestId, approved: false },
    });
    if (denied.statusCode !== 200) throw new Error(`needs-approval: deny failed (${denied.statusCode})`);

    const deadline2 = Date.now() + 10_000;
    for (;;) {
      const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: booted.client.headers });
      const state = (res.json() as { state: string }).state;
      if (state === "FAILED" || state === "COMPLETED") break;
      if (Date.now() > deadline2) throw new Error("needs-approval: task did not settle after denial");
      await new Promise((r) => setTimeout(r, 20));
    }

    return scoreTask(booted.db, { scenario: "needs-approval", kind: "fake", taskId });
  } finally {
    await booted.close();
  }
}
