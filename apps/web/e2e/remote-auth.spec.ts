/**
 * B2 remote auth in a real browser (phone viewport): the private Web link behind a
 * Tailscale-Serve-like TLS proxy on loopback, the shared fake OIDC issuer, and the plane's two
 * listeners. The browser resolves the canonical tailnet name to 127.0.0.1 and accepts the rig's
 * test-only certificate; nothing leaves loopback and no provider or account is involved.
 *
 * Cases: sign-in screen before any data; owner sign-in returns to the screen the link opened;
 * a command from the UI carries CSRF; the session cookie is invisible to JavaScript; a hostile
 * page on another origin cannot command; a non-owner gets nothing; idle expiry and sign-out send
 * the app back to sign-in and the old cookie stops working.
 */
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { devices, expect, test, type Page } from "@playwright/test";
import { CANONICAL_HOST, startRemoteRig, type RemoteRig } from "../../api/test/helpers/remote-rig.js";

const iPhone = devices["iPhone 13"];
test.use({
  viewport: iPhone.viewport, deviceScaleFactor: iPhone.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: iPhone.userAgent,
  ignoreHTTPSErrors: true,
  // The tailnet name resolves to loopback, and no outbound proxy (a sandbox's https_proxy) may see it.
  launchOptions: {
    args: [`--host-resolver-rules=MAP ${CANONICAL_HOST} 127.0.0.1`, "--no-proxy-server"],
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all)_proxy$/i.test(k))) as Record<string, string>,
  },
});

const SHOTS = process.env.B2_SHOTS_DIR;
const shot = async (page: Page, name: string) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };

let rig: RemoteRig;
test.beforeEach(async () => { rig = await startRemoteRig({ session: { absoluteTtlSeconds: 3600, idleTtlSeconds: 600 } }); });
test.afterEach(async () => { await rig.close(); });

const localCreate = async (goal: string) => {
  const res = await fetch(`http://127.0.0.1:${rig.localPort}/api/tasks`, { method: "POST", headers: { ...rig.bearer(), "content-type": "application/json" }, body: JSON.stringify({ goal }) });
  return ((await res.json()) as { taskId: string }).taskId;
};
const tasks = () => rig.db.prepare("SELECT goal FROM tasks ORDER BY created_at").all() as Array<{ goal: string }>;

async function signIn(page: Page) {
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

test("the private link shows sign-in first, then the owner lands on the mission the link named", async ({ page }) => {
  const id = await localCreate("Phone check: remote mission");
  const apiCalls: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && u.pathname !== "/api/auth/session") apiCalls.push(u.pathname); });
  await page.goto(`${rig.canonicalOrigin}/#/missions/${id}`);
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await expect(page.getByText("This private link needs the owner's sign-in.")).toBeVisible();
  await expect(page.getByText("Phone check: remote mission")).toHaveCount(0);
  expect(apiCalls).toEqual([]); // nothing but the session probe before sign-in
  await shot(page, "1-signin");
  await signIn(page);
  await expect(page).toHaveURL(new RegExp(`#/missions/${id}$`));
  await expect(page.getByText("Phone check: remote mission").first()).toBeVisible();
  await shot(page, "2-mission-after-signin");
  // The session cookie is HttpOnly: the page cannot read it; nor is any credential in storage or the URL.
  expect(await page.evaluate(() => document.cookie)).not.toContain("acp_remote_session");
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toMatch(/csrf|session/i);
  const cookie = (await page.context().cookies()).find((c) => c.name === "__Host-acp_remote_session")!;
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/", domain: CANONICAL_HOST });
});

test("a command from the UI carries the CSRF token and runs once", async ({ page }) => {
  await page.goto(`${rig.canonicalOrigin}/#/shell`);
  await signIn(page);
  const posts: Array<{ url: string; csrf: string | undefined }> = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/tasks") posts.push({ url: r.url(), csrf: r.headers()["x-csrf-token"] }); });
  await page.getByRole("form", { name: "Command" }).getByRole("textbox").fill("Created from the phone over the private link");
  await page.getByRole("form", { name: "Command" }).getByRole("button").first().click();
  await expect(page.getByRole("region", { name: "Routing recommendation" })).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.csrf).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(tasks().filter((t) => t.goal === "Created from the phone over the private link")).toHaveLength(1);
  await shot(page, "3-command-from-phone");
});

test("a hostile page on another origin cannot read or command with the owner's browser", async ({ page }) => {
  await page.goto(`${rig.canonicalOrigin}/`);
  await signIn(page);
  const before = tasks().length;
  const evil: Server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><form id=f method=POST action="${rig.canonicalOrigin}/api/tasks" enctype="text/plain"><input name='{"goal":"evil form","x":"' value='"}'></form>
<script>
window.results = {};
fetch("${rig.canonicalOrigin}/api/tasks", { credentials: "include" }).then(r => r.status, e => "blocked").then(v => window.results.read = v);
fetch("${rig.canonicalOrigin}/api/tasks", { method: "POST", credentials: "include", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ goal: "evil fetch" }) }).then(() => window.results.write = "sent", () => window.results.write = "blocked");
</script>`);
  });
  await new Promise<void>((r) => evil.listen(0, "127.0.0.1", () => r()));
  const evilOrigin = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;
  try {
    const attacker = await page.context().newPage();
    await attacker.goto(evilOrigin);
    await attacker.waitForFunction(() => (window as unknown as { results: { read?: unknown; write?: unknown } }).results.write !== undefined && (window as unknown as { results: { read?: unknown } }).results.read !== undefined);
    // The read is blocked by the browser (no CORS) and the server refused it anyway; the no-cors write had no effect.
    expect(await attacker.evaluate(() => (window as unknown as { results: { read: unknown } }).results.read)).toBe("blocked");
    await attacker.evaluate(() => (document.getElementById("f") as HTMLFormElement).submit());
    await attacker.waitForLoadState();
    expect(tasks().length).toBe(before);
    expect(tasks().map((t) => t.goal)).not.toContain("evil fetch");
  } finally { evil.closeAllConnections(); evil.close(); }
});

test("a non-owner account is refused and gets no session", async ({ page }) => {
  rig.issuer.loginAs = { sub: "FAKE-intruder-sub-not-real", email: "FAKE-owner@example-not-real" };
  await page.goto(`${rig.canonicalOrigin}/`);
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page.getByRole("heading", { name: "Not allowed" })).toBeVisible();
  expect((await page.context().cookies()).find((c) => c.name === "__Host-acp_remote_session")).toBeUndefined();
  await shot(page, "4-not-owner");
});

test("idle expiry and sign-out send the app back to sign-in; the old cookie stops working", async ({ page }) => {
  await page.goto(`${rig.canonicalOrigin}/`);
  await signIn(page);
  const first = (await page.context().cookies()).find((c) => c.name === "__Host-acp_remote_session")!;
  rig.clock.now = new Date(rig.clock.now.getTime() + 601_000);
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await signIn(page);
  await shot(page, "5-signed-in-overview");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("You are signed out.")).toBeVisible();
  await shot(page, "6-signed-out");
  const second = rig.db.prepare("SELECT revoked_reason FROM remote_sessions ORDER BY issued_at").all() as Array<{ revoked_reason: string | null }>;
  expect(second.map((r) => r.revoked_reason)).toEqual([null, "logout"]); // the first expired (not revoked), the second logged out
  // Both handles are dead now, whatever the browser still holds.
  const probe = await page.evaluate(async () => (await fetch("/api/tasks", { credentials: "include" })).status);
  expect(probe).toBe(401);
  void first;
});
