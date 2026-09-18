import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../../api/src/config.js";
import { openDb } from "../../api/src/db/index.js";
import { buildServer } from "../../api/src/server.js";

test("real headless CLI delivers the browser's HttpOnly session after the old token window", async ({ page, context }) => {
  const home = mkdtempSync(join(tmpdir(), "acp-headless-e2e-"));
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  config.api.port = 4276;
  const db = openDb(config.dbPath);
  const built = buildServer({ config, db });
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  try {
    built.registry.init();
    await built.app.listen({ host: "127.0.0.1", port: 4276 });
    child = spawn("pnpm", ["--filter", "@agent-plane/api", "open", "--headless", "--origin", "http://127.0.0.1:4276"], {
      cwd: resolve("../.."),
      env: { ...process.env, AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: "personal", DISPLAY: "", WAYLAND_DISPLAY: "", FORCE_COLOR: undefined },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    exited = new Promise((done) => child!.once("exit", done));
    let output = "";
    let errors = "";
    child.stdout!.on("data", (chunk) => { output += String(chunk); });
    child.stderr!.on("data", (chunk) => { errors += String(chunk); });
    await expect.poll(() => output, { timeout: 30_000 }).toContain("Browser bootstrap ready.");
    const origin = output.match(/Open (http:\/\/127\.0\.0\.1:\d+)/)![1]!;
    expect(output).toContain("300 seconds");
    // Real elapsed time proves CLI wait and token TTL are independent.
    await new Promise((done) => setTimeout(done, 11_000));
    const exchange = page.waitForRequest((req) => req.url().endsWith("/api/auth/bootstrap"));
    await page.goto(origin);
    expect((await exchange).headers().origin).toBe(origin);
    await expect(page).toHaveURL("http://127.0.0.1:4276/");
    await expect(page.getByRole("navigation", { name: "System" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => fetch("/api/workspace").then((r) => r.status))).toBe(200);
    const cookie = (await context.cookies()).find((c) => c.name === "__Host-acp_session");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    expect(await page.evaluate(() => document.cookie)).not.toContain("__Host-acp_session");
    expect(await exited).toBe(0);
    await expect(fetch(origin)).rejects.toThrow();
    expect(errors).toBe("");
  } finally {
    if (child && child.exitCode === null) {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
      await exited;
    }
    await built.app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
