import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, type Server, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OBSERVABILITY_CAPABILITIES } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { parseBootstrapToken } from "../src/auth/bootstrap-token.js";
import { atomicWriteCredential, credentialPath, readCredential } from "../src/auth/credential-file.js";
import { startOpenWeb, type OpenWebListener, type OpenWebOptions } from "../src/bin/open-web.js";
import { openDb } from "../src/db/index.js";
import { buildServer } from "../src/server.js";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof ChildProcessModule>(), spawn: vi.fn() }));
let home: string;
let config: ResolvedConfig;
let listeners: OpenWebListener[];
let extras: Server[];
let output: string;
let warnings: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "acp-open-web-"));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  listeners = [];
  extras = [];
  output = "";
  warnings = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { warnings += String(chunk); return true; });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const listener of listeners) {
    listener.server.close();
    listener.server.closeAllConnections();
    await listener.closed;
  }
  for (const server of extras) await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  rmSync(home, { recursive: true, force: true });
});
async function start(options: OpenWebOptions = {}) {
  const listener = await startOpenWeb({ config, headless: true, ...options });
  listeners.push(listener);
  return listener;
}
function get(origin: string, path = "/", headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; html: string; headers: IncomingHttpHeaders }>((done, reject) => {
    const req = request(`${origin}${path}`, { method, headers, agent: false }, (res) => {
      let html = "";
      res.on("data", (chunk) => { html += String(chunk); });
      res.on("end", () => done({ status: res.statusCode!, html, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}
const encodedToken = (html: string) => html.match(/name="token" value="([^"]+)"/)![1]!;
function setCapabilities(capabilities: string[]) {
  const file = readCredential(credentialPath(config.dir));
  file.secrets.forEach((secret) => { secret.capabilities = capabilities; });
  atomicWriteCredential(credentialPath(config.dir), file);
}
function fakeClock() { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); }

describe("open-web launcher", () => {
  it("headless never launches a browser; prints a token-free URL and correct loopback SSH forward", async () => {
    const browser = vi.fn();
    const listener = await start({ openBrowser: browser });
    const address = listener.server.address();
    if (!address || typeof address === "string") throw new Error("launcher did not bind TCP");
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    expect(output).toContain(`Open ${listener.origin}`);
    expect(output).toContain(`-L 127.0.0.1:${address.port}:127.0.0.1:${address.port} <ssh-host>`);
    expect(output).toContain("300 seconds");
    expect(browser).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    const page = await get(listener.origin);
    const token = encodedToken(page.html);
    const secret = readCredential(credentialPath(config.dir)).secrets[0]!.secret;
    expect(output).not.toContain(token);
    expect(output).not.toContain(secret);
    expect(page.html).not.toContain(secret);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toMatch(/^default-src 'none'; form-action http:\/\/127\.0\.0\.1:4176; script-src 'nonce-[A-Za-z0-9_-]+'$/);
    expect(parseBootstrapToken(token)?.payload.lo).toBe(listener.origin);
    await listener.closed;
    expect(listener.server.listening).toBe(false);
  });

  it("serves exactly one page, even for pipelined requests accepted before close", async () => {
    const listener = await start();
    const url = new URL(listener.origin);
    const replies = await new Promise<string>((done, reject) => {
      const socket = connect(Number(url.port), "127.0.0.1", () => {
        socket.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\n\r\nGET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
      });
      let text = "";
      socket.on("data", (chunk) => { text += String(chunk); });
      socket.on("end", () => done(text));
      socket.on("error", reject);
    });
    expect(replies.match(/name="token"/g)).toHaveLength(1);
    await listener.closed;
    await expect(get(listener.origin)).rejects.toThrow();
  });

  it.each([undefined, 60])("waits for the whole budget (%s), then mints a fresh 10-second token", async (waitSeconds) => {
    fakeClock();
    const listener = await start({ waitSeconds });
    await vi.advanceTimersByTimeAsync(((waitSeconds ?? 300) - 1) * 1000);
    expect(listener.server.listening).toBe(true);
    const page = await get(listener.origin);
    expect(page.status).toBe(200);
    expect(parseBootstrapToken(encodedToken(page.html))?.payload.exp).toBe(Math.floor(Date.now() / 1000) + 10);
    await listener.closed;
    await vi.advanceTimersByTimeAsync(1000);
    expect(output).not.toContain("expired");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires unused at the deadline and disconnects incomplete requests", async () => {
    fakeClock();
    const listener = await start({ waitSeconds: 60 });
    const socket = connect(Number(new URL(listener.origin).port), "127.0.0.1");
    await new Promise<void>((done) => socket.once("connect", done));
    socket.write("GET / HTTP/1.1\r\n");
    const disconnected = new Promise<void>((done) => socket.once("close", () => done()));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(listener.server.listening).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await listener.closed;
    await disconnected;
    expect(listener.server.listening).toBe(false);
    expect(output).toContain("expired");
  });

  it("rejects a request at the deadline even if the timer callback has not run", async () => {
    fakeClock();
    const listener = await start({ waitSeconds: 1 });
    vi.setSystemTime(Date.now() + 1000);
    expect((await get(listener.origin)).status).toBe(410);
  });

  it("binds a requested port and fails clearly on collision without opening a browser", async () => {
    const occupied = createServer();
    extras.push(occupied);
    await new Promise<void>((done) => occupied.listen(0, "127.0.0.1", done));
    const address = occupied.address() as { port: number };
    const browser = vi.fn();
    await expect(start({ port: address.port, openBrowser: browser })).rejects.toThrow(`Bootstrap port ${address.port} is already in use on 127.0.0.1`);
    expect(browser).not.toHaveBeenCalled();
    expect(output).toBe("");
    await new Promise<void>((done) => occupied.close(() => done()));
    const listener = await start({ port: address.port });
    expect(listener.origin).toBe(`http://127.0.0.1:${address.port}`);
  });

  it.each([{ port: -1 }, { port: 65536 }, { port: 1.5 }, { waitSeconds: 0 }, { waitSeconds: 901 }, { waitSeconds: NaN }, { waitSeconds: Infinity }])("rejects invalid bounded options %j", async (options) => {
    await expect(start(options)).rejects.toThrow("must be an integer");
  });

  it("preserves desktop browser launch", async () => {
    const browser = vi.fn();
    const listener = await start({ headless: false, openBrowser: browser });
    expect(browser).toHaveBeenCalledExactlyOnceWith(listener.origin);
    expect((await get(listener.origin)).status).toBe(200);
  });

  it("detects Linux without DISPLAY or WAYLAND_DISPLAY", async () => {
    if (process.platform !== "linux") return;
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");
    await start({ headless: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["ENOENT", "exit"])("handles actual launcher %s events and keeps the listener useful", async (failure) => {
    vi.stubEnv("DISPLAY", ":99");
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const listener = await start({ headless: false });
    expect(spawn).toHaveBeenCalled();
    if (failure === "ENOENT") child.emit("error", Object.assign(new Error("private child error"), { code: "ENOENT" }));
    else child.emit("exit", 3, null);
    await new Promise<void>((done) => setImmediate(done));
    expect(warnings).toContain("continuing in headless mode");
    expect(warnings).not.toContain("private child error");
    if (failure === "ENOENT") expect(warnings).toContain("ENOENT");
    expect((await get(listener.origin)).status).toBe(200);
  });

  it("does not leak a thrown browser-launch error or tear down the listener", async () => {
    const listener = await start({ headless: false, openBrowser: () => { throw new Error("secret canary"); } });
    await new Promise<void>((done) => setImmediate(done));
    expect(warnings).toContain("continuing in headless mode");
    expect(warnings).not.toContain("secret canary");
    expect((await get(listener.origin)).status).toBe(200);
  });

  it("fails closed for missing capabilities, including read-only browser reads", async () => {
    const browser = vi.fn();
    setCapabilities(["tasks.read"]);
    await expect(start({ openBrowser: browser })).rejects.toThrow("browser capabilities");
    await expect(start({ readOnly: true })).rejects.toThrow("browser capabilities");
    expect(browser).not.toHaveBeenCalled();
    expect(output).toBe("");
  });

  it("rechecks capabilities after waiting and closes without issuing a token on revocation", async () => {
    const listener = await start();
    setCapabilities(["tasks.read"]);
    const page = await get(listener.origin);
    expect(page.status).toBe(403);
    expect(page.html).not.toContain('name="token"');
    await listener.closed;
  });

  it("does not consume the page for HEAD, unrelated paths, foreign hosts or cross-site navigation", async () => {
    const listener = await start();
    expect((await get(listener.origin, "/", {}, "HEAD")).status).toBe(410);
    expect((await get(listener.origin, "/favicon.ico")).status).toBe(410);
    expect((await get(listener.origin, "/", { host: "evil.example" })).status).toBe(403);
    expect((await get(listener.origin, "/", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(listener.origin)).status).toBe(200);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("closes and removes signal handlers on %s", async (signal) => {
    const before = process.listenerCount(signal);
    const listener = await start();
    expect(process.listenerCount(signal)).toBe(before + 1);
    process.emit(signal);
    await listener.closed;
    expect(process.listenerCount(signal)).toBe(before);
  });

  it("exchanges a delayed headless read-only token through real auth; rejects replay, wrong origin and writes", async () => {
    fakeClock();
    setCapabilities([...OBSERVABILITY_CAPABILITIES]);
    await expect(start()).rejects.toThrow("browser capabilities");
    const db = openDb(config.dbPath);
    const built = buildServer({ config, db });
    try {
      const listener = await start({ readOnly: true });
      await vi.advanceTimersByTimeAsync(240_000);
      const page = await get(listener.origin);
      await listener.closed;
      const token = encodedToken(page.html);
      const exchangeTime = Date.now();
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(exchangeTime);
      const bootstrap = (origin: string) => built.app.inject({ method: "POST", url: "/api/auth/bootstrap", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ token }).toString() });
      expect((await bootstrap("http://127.0.0.1:9999")).statusCode).toBe(403);
      const response = await bootstrap(listener.origin);
      expect(response.statusCode).toBe(303);
      expect(response.headers["set-cookie"]).toContain("HttpOnly; Secure; SameSite=Strict; Path=/");
      expect((await bootstrap(listener.origin)).statusCode).toBe(401);
      const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
      expect((await built.app.inject({ url: "/api/workspace", headers: { cookie, origin: "http://127.0.0.1:4176" } })).statusCode).toBe(200);
      expect((await built.app.inject({ method: "POST", url: "/api/tasks", headers: { cookie, origin: "http://127.0.0.1:4176" }, payload: { goal: "forbidden" } })).statusCode).toBe(403);
    } finally {
      await built.app.close();
      db.close();
    }
  });
});
