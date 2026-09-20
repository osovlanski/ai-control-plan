/**
 * Delivery state, end to end in a real browser against a real plane.
 *
 * The state under test is the one the adapter slice found and nothing could
 * see: `manual_recovery_required` — an attempt was taken, its outcome is
 * unknown, and the provider guarantees neither a receipt lookup nor a safe
 * second send, so the plane refuses to resend and waits for a human.
 *
 * Nothing is faked in the UI. A scripted adapter loses one acknowledgement,
 * and every state rendered below is read back from the plane's own ledger.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeAdapter, FakeSessionInputAdapter } from "@agent-plane/adapters";
import { boot, A, type Harness } from "./harness.js";

const captures = fileURLToPath(new URL("../../../docs/ui/assets/session-input-delivery/", import.meta.url));
const capture = async (page: Page, name: string) => {
  mkdirSync(captures, { recursive: true });
  // The composer docks to the viewport; pin it in flow so the evidence never occludes the transcript.
  const pinned = await page.addStyleTag({ content: ".shell-dock { position: static; }" });
  await page.screenshot({ path: `${captures}${name}.png`, fullPage: true });
  await pinned.evaluate(node => (node as Element).remove());
};

/** A long-running session to address: the provider is still working when we write to it. */
const working = () => new FakeAdapter(A, {
  ok: true,
  delayMs: 600_000,
  events: [{ type: "message", summary: "Reading the migration", phase: "editing", payload: { text: "…" } }],
});

test.describe("delivery state is visible and recoverable", () => {
  let h: Harness;
  // Neither guarantee, so an unknown outcome can never be reconciled automatically.
  const provider = new FakeSessionInputAdapter({ receiptLookup: false, idempotentSend: false });

  test.beforeEach(async () => {
    h = await boot(4195, "session-input-delivery", { [A]: { provider: "fake" } }, undefined, config => {
      config.execution = { harnessModes: { single: true } };
      config.sessionInput = { enabled: true };
    }, new Map([[A, working()]]), undefined, () => provider);
  });
  test.afterEach(async () => { await h.close(); });

  test("shows an unresolved delivery inline, then names manual recovery and offers the plane's own retry", async ({ context }) => {
    const api = await h.privileged();
    const taskId = (await (await api.post("/api/tasks", { data: { goal: "Reconcile the ledger partitions" } })).json()).taskId;
    await api.post(`/api/tasks/${taskId}/start`, { data: { assistantId: A } });
    await expect.poll(async () => (await (await api.get(`/api/tasks/${taskId}/sessions`)).json())[0]?.sessionState).toBe("RUNNING");

    const page = await h.openApp(context);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${h.origin}/#/shell/${taskId}`);
    await page.reload();

    // The provider WILL receive this; only the acknowledgement is lost. The
    // plane therefore cannot claim delivery and must not claim refusal either.
    provider.failNext("lost-ack");
    const composer = page.getByRole("textbox", { name: "Follow-up to this mission" });
    await expect(composer).toBeEnabled();
    await composer.fill("also check the down migration");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const transcript = page.getByRole("region", { name: "Your follow-up messages" });
    await expect(transcript.getByText("also check the down migration")).toBeVisible();
    await expect(transcript.getByText(/^Sent, but delivery could not be confirmed/)).toBeVisible();
    await capture(page, "shell-delivery-unknown");

    // Sending again under the SAME client key is a reconcile, not a second
    // message: the plane asks the adapter, cannot get an answer, and says so.
    await page.getByRole("button", { name: "Retry this message", exact: true }).click();
    await expect(transcript.getByText("Delivery unresolved · needs manual recovery")).toBeVisible();
    await expect(transcript.getByText(/will not resend/)).toBeVisible();
    await expect(transcript.getByRole("button", { name: "Retry this delivery" })).toBeVisible();
    await capture(page, "shell-manual-recovery");

    // One logical message, one delivery, one attempt — the state is visible, not invented.
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get() as { n: number }).n).toBe(1);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM session_input_attempts").get() as { n: number }).n).toBe(1);
    expect(provider.received((await (await api.get(`/api/tasks/${taskId}/sessions`)).json())[0].sessionId)).toHaveLength(1);

    // The operator affordance this slice exists for: the same record, findable
    // without knowing which mission to open.
    await page.getByRole("link", { name: "Operator mode", exact: true }).click();
    await page.getByRole("link", { name: "Traces", exact: true }).click();
    const recovery = page.getByRole("region", { name: "Delivery recovery" });
    await expect(recovery.getByText("1 message needs manual recovery.")).toBeVisible();
    await expect(recovery.getByText("also check the down migration")).toBeVisible();
    await expect(recovery.getByText("Delivery unresolved · needs manual recovery")).toBeVisible();
    await expect(recovery.getByText(new RegExp(`Mission ${taskId}`))).toBeVisible();
    await capture(page, "operator-delivery-recovery");

    // The plane's own retry, from the operator surface. It is still unresolvable,
    // and the honest outcome is that the record does not change.
    await recovery.getByRole("button", { name: "Retry this delivery" }).click();
    await expect(recovery.getByText("Delivery unresolved · needs manual recovery")).toBeVisible();
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get() as { n: number }).n).toBe(1);

    await recovery.getByRole("link", { name: "Open the conversation" }).click();
    await expect(page.getByRole("region", { name: "Your follow-up messages" })).toBeVisible();
  });
});

test.describe("with the capability off", () => {
  let h: Harness;
  test.beforeEach(async () => {
    // No `sessionInput` block at all: the default, exactly as a workspace ships.
    h = await boot(4196, "session-input-delivery-off", { [A]: { provider: "fake" } }, undefined, config => {
      config.execution = { harnessModes: { single: true } };
    }, new Map([[A, working()]]));
  });
  test.afterEach(async () => { await h.close(); });

  test("adds nothing to Traces and leaves the composer exactly as it shipped", async ({ context }) => {
    const api = await h.privileged();
    const taskId = (await (await api.post("/api/tasks", { data: { goal: "Reconcile the ledger partitions" } })).json()).taskId;
    await api.post(`/api/tasks/${taskId}/start`, { data: { assistantId: A } });
    await expect.poll(async () => (await (await api.get(`/api/tasks/${taskId}/sessions`)).json())[0]?.sessionState).toBe("RUNNING");

    const page = await h.openApp(context);
    await page.getByRole("link", { name: "Traces", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Traces" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Delivery recovery" })).toHaveCount(0);

    await page.goto(`${h.origin}/#/shell/${taskId}`);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Follow-up to this mission" })).toBeDisabled();
    await expect(page.getByPlaceholder("Session-addressed text delivery is not available yet.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Your follow-up messages" })).toHaveCount(0);
    // Not merely hidden: with the capability off the plane writes no ledger row at all.
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get() as { n: number }).n).toBe(0);
  });
});
