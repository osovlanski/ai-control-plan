/**
 * The Cockpit bearer token, and anything else the peer quotes back, must not reach an error
 * message, a log line, the sync-state table or an API read: only a classified reason survives.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { BundleRequestError, CockpitBundleClient } from "../src/modules/bundle-request.js";
import { CockpitRegistryClient, RegistryFederation, RegistrySyncError } from "../src/modules/registry-federation.js";

const TOKEN = "FAKE-cockpit-token-not-real";
const PEER_TEXT = "FAKE-peer-quoted-value-not-real";

let dir: string;
let db: Db;
let tokenPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "registry-redact-"));
  db = openDb(join(dir, "t.db"));
  tokenPath = join(dir, "token");
  writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const reply = (body: string, status = 200) =>
  (async () => new Response(body, { status, headers: { "x-cockpit-registry-version": "1.0" } })) as unknown as typeof fetch;

const hostile: Array<[string, typeof fetch]> = [
  ["token in an error body", reply(`{"error":"bad bearer ${TOKEN}"}`, 500)],
  ["token in a 401 body", reply(`{"error":"${TOKEN}"}`, 401)],
  ["token as the schema version", reply(JSON.stringify({ schemaVersion: TOKEN, assets: [] }))],
  ["token as a digest", reply(JSON.stringify({ schemaVersion: "1.0", snapshotDigest: TOKEN, assets: [] }))],
  ["JSON-escaped token", reply(`{"schemaVersion":"1.0","assets":[],"x":"${[...TOKEN].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`)],
  ["peer text as the schema version", reply(JSON.stringify({ schemaVersion: PEER_TEXT, assets: [] }))],
  ["peer text as a digest", reply(JSON.stringify({ schemaVersion: "1.0", snapshotDigest: PEER_TEXT, assets: [] }))],
];

describe("registry client errors", () => {
  for (const [name, fetcher] of hostile) {
    it(`carry no token or peer text: ${name}`, async () => {
      const err = await new CockpitRegistryClient("http://127.0.0.1:8787", tokenPath, fetcher).snapshot().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RegistrySyncError);
      const e = err as RegistrySyncError;
      const seen = JSON.stringify({ message: e.message, reason: e.reason, detail: (e as { detail?: string }).detail, stack: e.stack });
      expect(seen).not.toContain(TOKEN);
      expect(seen).not.toContain(PEER_TEXT);
    });
  }

  it("refuses a response that echoes the token, as the bundle client does", async () => {
    const err = await new CockpitRegistryClient("http://127.0.0.1:8787", tokenPath, hostile[2]![1]).snapshot().catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "invalid_response" });
  });
});

describe("bundle client errors", () => {
  for (const [name, fetcher] of hostile) {
    it(`carry no token or peer text: ${name}`, async () => {
      const err = await new CockpitBundleClient("http://127.0.0.1:8787", tokenPath, fetcher)
        .render({} as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundleRequestError);
      const e = err as BundleRequestError;
      const seen = JSON.stringify({ message: e.message, reason: e.reason, detail: e.detail, stack: e.stack });
      expect(seen).not.toContain(TOKEN);
      expect(seen).not.toContain(PEER_TEXT);
    });
  }
});

describe("registry federation sync", () => {
  it("keeps the token and peer text out of logs, tables and the API read", async () => {
    const warn = vi.fn();
    const config = { enabled: true, baseUrl: "http://127.0.0.1:8787", tokenPath, maxCacheAgeHours: 1 };
    for (const [, fetcher] of hostile) {
      const fed = new RegistryFederation(db, config, new CockpitRegistryClient(config.baseUrl, tokenPath, fetcher), () => new Date("2026-10-05T10:00:00.000Z"), { warn });
      const result = await fed.sync();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(fed.read())).not.toContain(TOKEN);
    }
    const rows = JSON.stringify(db.prepare("SELECT * FROM registry_sync_state").all());
    const logs = JSON.stringify(warn.mock.calls);
    for (const text of [rows, logs]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(PEER_TEXT);
    }
    expect(warn).toHaveBeenCalled();
  });
});
