/**
 * M4 registry federation: Cockpit registry v1 snapshots cached as catalog
 * metadata, change rows, and availability semantics (last good snapshot,
 * stale past maxCacheAgeHours, no fallback, no token at rest).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_PLANE_API_VERSION, OBSERVABILITY_CAPABILITIES } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { atomicWriteCredential, credentialPath, readCredential } from "../src/auth/credential-file.js";
import { scheduleDailyJobs } from "../src/modules/jobs.js";
import {
  CockpitRegistryClient, RegistryFederation, RegistrySyncError, readRegistryToken, type RegistrySnapshotSource,
} from "../src/modules/registry-federation.js";
import { computeSnapshotDigest, REGISTRY_CONTRACT_DIR, type RegistryAsset, type RegistrySnapshot } from "../src/registry-contract.js";
import { buildServer, type BuiltServer } from "../src/server.js";

const valid = (): RegistrySnapshot =>
  JSON.parse(readFileSync(join(REGISTRY_CONTRACT_DIR, "fixtures/valid/snapshot.json"), "utf8")) as RegistrySnapshot;
const withAssets = (assets: RegistryAsset[]): RegistrySnapshot => ({ schemaVersion: "1.0", snapshotDigest: computeSnapshotDigest(assets), assets });
const bumpDigest = (asset: RegistryAsset): RegistryAsset => ({ ...asset, digest: `sha256:${"e".repeat(64)}` });

let dir: string;
let db: Db;
let clock: Date;
const cockpit = (over: Partial<ResolvedConfig["registry"]["cockpit"]> = {}) => ({
  enabled: true, baseUrl: "http://127.0.0.1:8787", tokenPath: join(dir, "token"), maxCacheAgeHours: 1, ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "registry-fed-"));
  db = openDb(join(dir, "t.db"));
  clock = new Date("2026-10-05T10:00:00.000Z");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

class FakeSource implements RegistrySnapshotSource {
  next: RegistrySnapshot | RegistrySyncError = valid();
  async snapshot() {
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

describe("RegistryFederation", () => {
  it("is off by default and does nothing when disabled", async () => {
    const config = loadConfig({ AGENT_PLANE_HOME: dir });
    expect(config.registry.cockpit).toMatchObject({ enabled: false, maxCacheAgeHours: 48 });
    const source = new FakeSource();
    const spy = vi.spyOn(source, "snapshot");
    const fed = new RegistryFederation(db, config.registry.cockpit, source, () => clock);
    expect(await fed.sync()).toEqual({ ok: false, reason: "disabled" });
    expect(spy).not.toHaveBeenCalled();
    expect(fed.read()).toMatchObject({ enabled: false, snapshotDigest: null, assets: [], stale: true });
  });

  it("caches the snapshot; the first observation is a baseline with no change rows", async () => {
    const source = new FakeSource();
    const fed = new RegistryFederation(db, cockpit(), source, () => clock);
    expect(await fed.sync()).toEqual({ ok: true, snapshotDigest: valid().snapshotDigest, changes: 0 });
    const view = fed.read();
    expect(view).toMatchObject({ snapshotDigest: valid().snapshotDigest, schemaVersion: "1.0", observedAt: clock.toISOString(), stale: false });
    expect(view.assets).toEqual(valid().assets);
    expect(computeSnapshotDigest(view.assets)).toBe(view.snapshotDigest);
    expect(fed.recentChanges()).toEqual([]);
  });

  it("records added, removed and digest_changed rows, and nothing for an unchanged resync", async () => {
    const source = new FakeSource();
    const fed = new RegistryFederation(db, cockpit(), source, () => clock);
    await fed.sync();
    const [agent, skill, mcp] = valid().assets;
    const added: RegistryAsset = { ...agent!, id: "claude-skills:throwaway", kind: "skill", nativeKind: "claude-skills", name: "throwaway" };
    source.next = withAssets([agent!, bumpDigest(skill!), added].sort((a, b) => (a.id < b.id ? -1 : 1)));
    const result = await fed.sync();
    expect(result).toMatchObject({ ok: true, changes: 3 });
    const changes = fed.recentChanges() as Array<{ asset_id: string; change: string; old_digest: string | null; new_digest: string | null; source: string }>;
    expect(changes.map((c) => [c.asset_id, c.change]).sort()).toEqual([
      ["claude-skills:example-skill", "digest_changed"],
      ["claude-skills:throwaway", "added"],
      [mcp!.id, "removed"],
    ]);
    expect(changes.every((c) => c.source === "cockpit-registry")).toBe(true);
    expect(await fed.sync()).toMatchObject({ ok: true, changes: 0 });
  });

  it("keeps the last good snapshot on failure and turns stale past maxCacheAgeHours", async () => {
    const source = new FakeSource();
    const warn = vi.fn();
    const fed = new RegistryFederation(db, cockpit({ maxCacheAgeHours: 1 }), source, () => clock, { warn });
    await fed.sync();
    for (const reason of ["unreachable", "unauthenticated", "unsupported_version", "invalid_response"] as const) {
      source.next = new RegistrySyncError(reason);
      clock = new Date(clock.getTime() + 20 * 60_000);
      expect(await fed.sync()).toEqual({ ok: false, reason });
      expect(fed.read()).toMatchObject({ snapshotDigest: valid().snapshotDigest, lastFailure: reason });
      expect(fed.read().assets).toHaveLength(valid().assets.length);
    }
    // 80 minutes after the last success, past the 1h limit.
    expect(fed.read().stale).toBe(true);
    expect(warn).toHaveBeenLastCalledWith({ source: "cockpit", reason: "invalid_response", stale: true }, expect.any(String));
    source.next = valid();
    await fed.sync();
    expect(fed.read()).toMatchObject({ stale: false, lastFailure: null });
  });

  it("runs from the daily job", async () => {
    vi.useFakeTimers();
    try {
      const sync = vi.fn(async () => ({ ok: false as const, reason: "disabled" as const }));
      const registry = { syncChangedAll: vi.fn(async () => ({ synced: 0, failed: [] })) };
      const stop = scheduleDailyJobs(7, registry as never, { archive: vi.fn() } as never, undefined, undefined, { sync });
      await vi.advanceTimersByTimeAsync(25 * 3_600_000);
      stop();
      expect(sync).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("CockpitRegistryClient", () => {
  const TOKEN_VALUE = randomBytes(32).toString("base64url");
  const writeToken = (mode = 0o600) => {
    writeFileSync(join(dir, "token"), `${TOKEN_VALUE}\n`, { mode });
    chmodSync(join(dir, "token"), mode);
  };
  const respond = (body: unknown, init: { status?: number; version?: string } = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", "x-cockpit-registry-version": init.version ?? "1.0" },
    }));

  it("sends the bearer token and accepts a valid v1 snapshot", async () => {
    writeToken();
    const fetcher = respond(valid());
    const client = new CockpitRegistryClient("http://127.0.0.1:8787", join(dir, "token"), fetcher as unknown as typeof fetch);
    expect(await client.snapshot()).toEqual(valid());
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:8787/api/v1/registry/assets");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN_VALUE}`);
  });

  it("classifies every failure and rejects unknown majors and invalid bodies", async () => {
    writeToken();
    const path = join(dir, "token");
    const run = (fetcher: unknown) => new CockpitRegistryClient("http://127.0.0.1:8787", path, fetcher as typeof fetch).snapshot();
    const reason = async (p: Promise<unknown>) => { try { await p; return "resolved"; } catch (e) { return (e as RegistrySyncError).reason; } };

    expect(await reason(run(respond({ error: { code: "unauthenticated", message: "x" } }, { status: 401 })))).toBe("unauthenticated");
    expect(await reason(run(vi.fn(async () => { throw new TypeError("fetch failed"); })))).toBe("unreachable");
    expect(await reason(run(respond({ ...valid(), schemaVersion: "2.0" }, { version: "2.0" })))).toBe("unsupported_version");
    for (const file of ["missing-digest", "mcp-secret-value", "mcp-inline-secret-arg", "unordered-assets", "stale-snapshot-digest"]) {
      const body = JSON.parse(readFileSync(join(REGISTRY_CONTRACT_DIR, `fixtures/invalid/${file}.json`), "utf8"));
      expect(await reason(run(respond(body))), file).toBe("invalid_response");
    }
    expect(await reason(run(respond(valid(), { version: "1.3" })))).toBe("invalid_response");
    expect(await reason(run(respond({}, { status: 500 })))).toBe("http_error");
  });

  it("refuses a missing, symlinked or group-readable token file", () => {
    expect(() => readRegistryToken(join(dir, "token"))).toThrow(/token_file_missing/);
    writeToken(0o640);
    expect(() => readRegistryToken(join(dir, "token"))).toThrow(/token_file_unsafe/);
    writeToken(0o600);
    symlinkSync(join(dir, "token"), join(dir, "link"));
    expect(() => readRegistryToken(join(dir, "link"))).toThrow(/token_file_unsafe/);
    expect(readRegistryToken(join(dir, "token"))).toBe(TOKEN_VALUE);
  });

  it("never writes the token or an MCP secret value to the database", async () => {
    writeToken();
    const fed = new RegistryFederation(db, cockpit(), new CockpitRegistryClient("http://127.0.0.1:8787", join(dir, "token"), respond(valid()) as unknown as typeof fetch), () => clock);
    await fed.sync();
    const failing = new RegistryFederation(db, cockpit(), new CockpitRegistryClient("http://127.0.0.1:8787", join(dir, "token"), respond({}, { status: 401 }) as unknown as typeof fetch), () => clock);
    await failing.sync();
    db.close();
    const raw = readFileSync(join(dir, "t.db"));
    expect(raw.includes(TOKEN_VALUE)).toBe(false);
    db = openDb(join(dir, "t.db"));
  });
});

describe("registry config", () => {
  it("rejects a non-loopback baseUrl and a relative tokenPath when enabled", () => {
    const configFile = join(loadConfig({ AGENT_PLANE_HOME: dir }).dir, "config.yaml");
    writeFileSync(configFile, "registry:\n  cockpit:\n    enabled: true\n    baseUrl: http://example.invalid:8787\n    tokenPath: /tmp/x\n");
    expect(() => loadConfig({ AGENT_PLANE_HOME: dir })).toThrow(/http loopback origin/);
    writeFileSync(configFile, "registry:\n  cockpit:\n    enabled: true\n    tokenPath: relative/token\n");
    expect(() => loadConfig({ AGENT_PLANE_HOME: dir })).toThrow(/tokenPath must be an absolute path/);
  });
});

describe("GET /api/registry/assets", () => {
  let home: string;
  let built: BuiltServer;
  let hdb: Db;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "registry-api-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    config.registry.cockpit = cockpit();
    hdb = openDb(config.dbPath);
    const source = new FakeSource();
    built = buildServer({ config, db: hdb, registryFederation: new RegistryFederation(hdb, config.registry.cockpit, source, () => clock) });
    await built.registryFederation.sync();
  });
  afterEach(async () => {
    await built.app.close();
    hdb.close();
    rmSync(home, { recursive: true, force: true });
  });

  const secretWith = (dirPath: string, capabilities: string[]) => {
    const file = readCredential(credentialPath(dirPath));
    const next = { kid: `k_${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities, createdAt: new Date().toISOString(), notAfter: null };
    file.secrets.push(next);
    atomicWriteCredential(credentialPath(dirPath), file);
    return next.secret;
  };

  it("serves the cached snapshot under registry.read and advertises 2.4", async () => {
    const cfgDir = loadConfig({ AGENT_PLANE_HOME: home }).dir;
    expect(CONTROL_PLANE_API_VERSION).toBe("2.4");
    expect(OBSERVABILITY_CAPABILITIES).toContain("registry.read");
    const ok = await built.app.inject({ method: "GET", url: "/api/registry/assets", headers: { authorization: `Bearer ${secretWith(cfgDir, ["registry.read"])}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ snapshotDigest: valid().snapshotDigest, stale: false, observedAt: clock.toISOString(), enabled: true });
    expect(ok.json().assets).toHaveLength(3);
    const pre24 = await built.app.inject({ method: "GET", url: "/api/registry/assets", headers: { authorization: `Bearer ${secretWith(cfgDir, ["tasks.read", "models.read"])}` } });
    expect(pre24.statusCode).toBe(403);
    expect((await built.app.inject({ method: "GET", url: "/api/registry/assets" })).statusCode).toBe(401);
    const changes = await built.app.inject({ method: "GET", url: "/api/registry/changes", headers: { authorization: `Bearer ${secretWith(cfgDir, ["registry.read"])}` } });
    expect(changes.json()).toEqual({ changes: [] });
  });
});
