/**
 * The flag-gated Shell composer, end to end in a real browser against a real
 * plane. Proves the wiring the unit tests cannot: capability discovery turns
 * the composer on, a send produces ONE durable record, and a retry of the same
 * message produces no second one.
 */
import { expect, test } from "@playwright/test";
import { boot, A, type Harness } from "./harness.js";

let h: Harness;

test.beforeEach(async () => {
  h = await boot(4194, "session-input", { [A]: { provider: "fake" } }, undefined, config => {
    config.policy.approvalMode = "prompt-on-escalation";
    config.execution = { harnessModes: { single: true } };
    config.sessionInput = { enabled: true };
  });
});
test.afterEach(async () => { await h.close(); });

test("records one durable input per client key and never claims unproven delivery", async ({ context }) => {
  const api = await h.privileged();
  const id = (await (await api.post("/api/tasks", { data: { goal: "Review the migration [FAKE:APPROVAL]" } })).json()).taskId;
  await api.post(`/api/tasks/${id}/start`, { data: { assistantId: A } });
  await expect
    .poll(async () => (await (await api.get(`/api/tasks/${id}/sessions`)).json())[0]?.sessionState)
    .toBe("AWAITING_APPROVAL");

  const page = await h.openApp(context);
  await page.goto(`${h.origin}/#/shell/${id}`);
  await page.reload();

  const composer = page.getByRole("textbox", { name: "Follow-up to this mission" });
  await expect(composer).toBeEnabled();
  await composer.fill("check the down migration too");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // The session is approval-blocked, so the plane queues without bypassing the
  // approval — and the UI says exactly that, never "sent".
  await expect(page.getByText("Recorded · waiting to send (approval_pending)")).toBeVisible();
  const count = () => (h.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get() as { n: number }).n;
  expect(count()).toBe(1);

  // Retry of the SAME message: one logical row, still nothing delivered.
  await page.getByRole("button", { name: "Retry this message", exact: true }).click();
  await expect(page.getByText("Recorded · waiting to send (approval_pending)")).toBeVisible();
  expect(count()).toBe(1);
  expect(
    (h.db.prepare("SELECT COUNT(*) AS n FROM session_input_attempts").get() as { n: number }).n,
  ).toBe(0);
});
