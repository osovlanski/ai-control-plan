/**
 * Milestone B1: the mission view survives a phone lock, a background tab and a network change.
 *
 * A locked phone silently loses SSE frames. The page cannot be locked from Playwright, so the spec
 * reproduces exactly what the page sees: the tab goes `hidden`, the browser goes offline, and every
 * stream frame that arrives meanwhile is dropped before the page's handler (an init-script shim on
 * EventSource). The fake provider emits its events and asks for approval during that window. On
 * return the page must show every durable event exactly once and the approval the plane holds now.
 * Then approve-once: a double tap sends one answer, and a second tab answering later applies
 * nothing more. Fakes only, phone viewport, no credentials.
 */
import { devices, expect, test, type Page, type Request } from "@playwright/test";
import { boot, A, type Harness } from "./harness.js";

const iPhone = devices["iPhone 13"];
test.use({ viewport: iPhone.viewport, deviceScaleFactor: iPhone.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: iPhone.userAgent });

/** Installed before the app: lets the spec drop live frames and fake page visibility. */
const SHIM = () => {
  const w = window as unknown as { __dropFrames: boolean; __hidden: boolean; __dropped: number };
  w.__dropFrames = false;
  w.__hidden = false;
  w.__dropped = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (w.__hidden ? "hidden" : "visible") });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => w.__hidden });
  const Native = window.EventSource;
  class Lossy extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      let handler: ((m: MessageEvent<string>) => void) | null = null;
      Object.defineProperty(this, "onmessage", {
        configurable: true,
        get: () => handler,
        set: (fn: ((m: MessageEvent<string>) => void) | null) => {
          handler = fn;
          super.onmessage = fn && ((m: MessageEvent<string>) => { if (w.__dropFrames) w.__dropped += 1; else fn.call(this, m); });
        },
      });
    }
  }
  window.EventSource = Lossy as unknown as typeof EventSource;
};

async function lock(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __dropFrames: boolean; __hidden: boolean };
    w.__dropFrames = true;
    w.__hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.context().setOffline(true);
}

async function unlock(page: Page) {
  await page.context().setOffline(false);
  await page.evaluate(() => {
    const w = window as unknown as { __dropFrames: boolean; __hidden: boolean };
    w.__dropFrames = false;
    w.__hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

let h: Harness;

for (const harness of [true, false]) test.describe(harness ? "Harness session" : "legacy run", () => {
  test.beforeEach(async () => {
    h = await boot(harness ? 4264 : 4265, `reconnect-${harness ? "harness" : "legacy"}`, { [A]: { provider: "fake" } }, undefined, config => {
      config.policy.approvalMode = "prompt-on-escalation";
      if (harness) config.execution = { harnessModes: { single: true } };
    });
  });
  test.afterEach(async () => { await h.close(); });

  test("recovers missed events and the pending approval after a lock, then applies one approval", async ({ context }, info) => {
    await context.addInitScript(SHIM);
    const api = await h.privileged();
    const id = (await (await api.post("/api/tasks", { data: { goal: "Ship the changelog fix [FAKE:APPROVAL]" } })).json()).taskId as string;
    const page = await h.openApp(context);
    await page.goto(`${h.origin}/#/missions/${id}`);
    await expect(page.getByRole("heading", { name: id, exact: true })).toBeVisible();
    await expect(page.getByText("No events yet.")).toBeVisible();

    // Lock the phone, then let the run happen: every frame it publishes is lost to the page.
    await lock(page);
    await api.post(`/api/tasks/${id}/start`, { data: { assistantId: A } });
    const durable = async () => (await (await api.get(`/api/tasks/${id}/events`)).json()) as Array<{ run_id: string; seq: number; type: string }>;
    await expect.poll(async () => (await durable()).some(e => e.type === "approval.requested")).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __dropped: number }).__dropped)).toBeGreaterThan(0);
    await expect(page.getByRole("group", { name: "Approval requested" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("locked.png"), fullPage: true });

    // Back from the lock screen over a new network.
    await unlock(page);
    const card = page.getByRole("group", { name: "Approval requested" });
    await expect(card).toBeVisible();
    const expected = (await durable()).map(e => `${e.run_id}:${e.seq}`);
    const rows = page.locator("[data-event-key]");
    await expect(rows).toHaveCount(expected.length);
    expect(await rows.evaluateAll(els => els.map(e => e.getAttribute("data-event-key")))).toEqual(expected);
    // A second wake (another visibilitychange, an `online`) adds nothing.
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("online")); });
    await page.waitForTimeout(500);
    await expect(rows).toHaveCount(expected.length);
    await page.screenshot({ path: info.outputPath("recovered.png"), fullPage: true });

    // A second device has the same card open, but stays asleep through the answer.
    const other = await h.openApp(context);
    await other.goto(`${h.origin}/#/missions/${id}`);
    await expect(other.getByRole("group", { name: "Approval requested" })).toBeVisible();
    await other.evaluate(() => { (window as unknown as { __dropFrames: boolean }).__dropFrames = true; });

    // Double tap inside one frame: two clicks before React re-renders. One request leaves.
    const answers: Request[] = [];
    const count = (r: Request) => { if (r.method() === "POST" && r.url().endsWith(`/api/tasks/${id}/input`)) answers.push(r); };
    page.on("request", count);
    other.on("request", count);
    await card.getByRole("button", { name: "Approve", exact: true }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
    await expect(card).toHaveCount(0);
    expect(answers).toHaveLength(1);
    await h.waitForState(id, "COMPLETED");

    // The sleeping tab answers late, and the other way: the plane refuses it and the tab says so.
    await other.getByRole("group", { name: "Approval requested" }).getByRole("button", { name: "Deny", exact: true }).click();
    await expect(other.getByText(/This approval was already answered/)).toBeVisible();
    await expect(other.getByRole("group", { name: "Approval requested" })).toHaveCount(0);
    expect(answers).toHaveLength(2);
    await other.screenshot({ path: info.outputPath("second-tab-already-answered.png"), fullPage: true });

    // Exactly one answer applied: one run, one end, approved, and (Harness) one answered row.
    const after = await durable();
    expect(after.filter(e => e.type === "run.ended")).toHaveLength(1);
    expect(after.filter(e => e.type === "approval.requested")).toHaveLength(1);
    expect(h.built.tasks.get(id)?.state).toBe("COMPLETED");
    const rowsOfApprovals = h.db.prepare(
      "SELECT a.decision, a.answered_by FROM approvals a JOIN runs r ON r.id = a.session_id WHERE r.task_id = ?",
    ).all(id);
    expect(rowsOfApprovals).toEqual(harness ? [{ decision: "approved", answered_by: "user" }] : []);
    await api.dispose();
  });
});
