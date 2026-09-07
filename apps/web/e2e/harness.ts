/**
 * Shared in-process API harness for browser walkthroughs (Demo A, visual
 * reference captures). Boots a real server against a temporary workspace with
 * an injected clock and an injected K3 probe transport — deterministic, no
 * provider credentials, no wall-clock waits.
 */
import { expect, request, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../../api/src/config.js";
import { openDb, type Db } from "../../api/src/db/index.js";
import { buildServer, type BuiltServer } from "../../api/src/server.js";
import type { QuotaProbeFn, ProbeOutcome } from "../../api/src/modules/quota-probe.js";
import { credentialPath, readCredential } from "../../api/src/auth/credential-file.js";
import { mintBootstrapToken } from "../../api/src/auth/bootstrap-token.js";

export const A = "fake-a" as AssistantId;
export const B = "fake-b" as AssistantId;

export class Clock {
  constructor(public current = new Date("2026-09-06T12:00:00.000Z")) {}
  now = () => this.current;
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Deterministic K3 transport: an assistant with `demoProbe: "ok"` exposes an
 * idle endpoint; any other reports unsupported with its reason. */
export const demoProbe =
  (clock: Clock): QuotaProbeFn =>
  async (_provider, options): Promise<ProbeOutcome> => {
    if ((options as { demoProbe?: string }).demoProbe === "ok") {
      return {
        status: "ok",
        buckets: [
          {
            bucket: "five_hour",
            usedPercent: 37,
            resetsAt: new Date(clock.current.getTime() + 5 * 3_600_000).toISOString(),
          },
        ],
      };
    }
    return { status: "unsupported", buckets: [], detail: "no verified idle quota endpoint for fake (demo)" };
  };

export interface Harness {
  home: string;
  db: Db;
  built: BuiltServer;
  clock: Clock;
  origin: string;
  close(): Promise<void>;
  openApp(context: BrowserContext): Promise<Page>;
  privileged(): Promise<APIRequestContext>;
  waitForState(id: string, expected: string): Promise<void>;
}

export async function boot(
  port: number,
  prefix: string,
  assistants: ResolvedConfig["assistants"],
  clock = new Clock(),
  configure?: (config: ResolvedConfig) => void,
): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  config.api.port = port; // server's own `origin` (bootstrap `aud`) is derived from config, not listen()
  config.assistants = assistants;
  config.scheduler = { ...config.scheduler!, enabled: true, quotaProbe: true };
  configure?.(config);
  const db = openDb(config.dbPath);
  const built = buildServer({ config, db, now: clock.now, quotaProbeFn: demoProbe(clock) });
  built.registry.init();
  await built.registry.syncAll();
  await built.app.listen({ host: "127.0.0.1", port });
  const origin = `http://127.0.0.1:${port}`;
  const currentSecret = () =>
    readCredential(credentialPath(loadConfig({ AGENT_PLANE_HOME: home }).dir)).secrets.at(-1)!;

  /** Ephemeral single-use launcher page that bootstraps the SPA session (mirrors auth.spec). */
  const launcher = async (): Promise<{ url: string; server: Server }> => {
    let served = false;
    const secret = currentSecret();
    const server = createServer((_, res) => {
      if (served) {
        res.writeHead(410).end();
        return;
      }
      served = true;
      const token = mintBootstrapToken(secret, {
        aud: origin,
        lo: url,
        cap: secret.capabilities,
        exp: Math.floor(clock.current.getTime() / 1000) + 30,
      });
      res.setHeader("content-type", "text/html");
      res.end(
        `<form method=POST action="${origin}/api/auth/bootstrap"><input name=token value="${token}"></form><script>document.forms[0].submit()</script>`,
      );
      server.close();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port: p } = server.address() as { port: number };
    const url = `http://127.0.0.1:${p}`;
    return { url, server };
  };

  return {
    home,
    db,
    built,
    clock,
    origin,
    async close() {
      await built.app.close();
      if (db.open) db.close();
      rmSync(home, { recursive: true, force: true });
    },
    async openApp(context) {
      const l = await launcher();
      const page = await context.newPage();
      await page.goto(l.url);
      await expect(page.getByText("Agent Control Plane")).toBeVisible();
      await expect(page.getByRole("heading", { name: /Missions in orbit/ })).toBeVisible();
      return page;
    },
    privileged: () =>
      request.newContext({
        baseURL: origin,
        extraHTTPHeaders: { Authorization: `Bearer ${currentSecret().secret}` },
      }),
    waitForState: (id, expected) =>
      expect.poll(() => built.tasks.get(id)?.state, { timeout: 8000, intervals: [100] }).toBe(expected),
  };
}
