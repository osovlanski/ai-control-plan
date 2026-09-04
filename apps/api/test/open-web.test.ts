import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseBootstrapToken } from "../src/auth/bootstrap-token.js";
import { startOpenWeb } from "../src/bin/open-web.js";

let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe("open-web launcher", () => {
  it("binds an ephemeral loopback listener and serves one origin-bound bootstrap form", async () => {
    home = mkdtempSync(join(tmpdir(), "acp-open-web-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    let opened: string | undefined;
    const listener = await startOpenWeb({
      config,
      apiOrigin: "http://127.0.0.1:4176",
      openBrowser: (origin) => { opened = origin; },
    });
    const address = listener.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");
    if (!address || typeof address === "string") throw new Error("launcher did not bind TCP");
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    expect(listener.origin).toBe(`http://127.0.0.1:${address.port}`);
    expect(opened).toBe(listener.origin);

    const requests = await Promise.all([
      fetch(`${listener.origin}/`),
      fetch(`${listener.origin}/`),
    ]);
    expect(requests.map((response) => response.status).sort()).toEqual([200, 410]);
    const success = requests.find((response) => response.status === 200)!;
    expect(success.headers.get("content-security-policy")).toMatch(
      /^default-src 'none'; form-action http:\/\/127\.0\.0\.1:4176; script-src 'nonce-[A-Za-z0-9_-]+'$/,
    );
    const html = await success.text();
    const encoded = html.match(/<input type="hidden" name="token" value="([^"]+)">/)?.[1];
    expect(encoded).toBeTruthy();
    expect(html).toContain('action="http://127.0.0.1:4176/api/auth/bootstrap"');
    expect(parseBootstrapToken(encoded!)?.payload.lo).toBe(listener.origin);
    await listener.closed;
  });
});
