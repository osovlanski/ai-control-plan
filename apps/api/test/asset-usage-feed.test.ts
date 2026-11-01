/**
 * M6 S3 (docs/agentic-os-m6-composition-telemetry.md §3, §5 row S3): the asset usage v1 contract
 * and the feed Cockpit pulls, `GET /api/composition/asset-usage` under `telemetry.read` (API 2.7).
 * Every secret here is FAKE-*-not-real.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_OPTIONAL_CAPABILITIES, COMMAND_CAPABILITIES, CONTROL_PLANE_API_VERSION, INGEST_CAPABILITIES, OBSERVABILITY_CAPABILITIES } from "@agent-plane/core";
import { atomicWriteCredential, credentialPath, readCredential } from "../src/auth/credential-file.js";
import {
  ASSET_USAGE_CONTRACT_DIR,
  validateAssetUsageEvent,
  validateAssetUsagePage,
  type AssetUsagePage,
  type AssetUsageWireEvent,
} from "../src/asset-usage-contract.js";
import { bootRig, COCKPIT_TOKEN, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const GOAL = "Add a typed helper to the TypeScript parser module";
const PRE_27 = [...OBSERVABILITY_CAPABILITIES.filter((c) => c !== "telemetry.read"), ...COMMAND_CAPABILITIES, ...INGEST_CAPABILITIES];

async function runComposed(goal = GOAL): Promise<string> {
  const taskId = rig!.built.tasks.create({ goal, repoPath: rig!.repo }).taskId;
  const done = reaches(rig!.built, taskId, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  expect(await done).toBe("COMPLETED");
  return taskId;
}

/** Adds a bearer credential holding exactly `capabilities` (as a rotate with --capabilities would). */
function credentialWith(capabilities: readonly string[]): { authorization: string } {
  const path = credentialPath(rig!.config.dir);
  const file = readCredential(path);
  const next = { kid: `k_${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities: [...capabilities], createdAt: new Date().toISOString(), notAfter: null };
  file.secrets.push(next);
  atomicWriteCredential(path, file);
  return { authorization: `Bearer ${next.secret}` };
}

async function feed(query: string, headers = rig!.auth()) {
  const res = await rig!.built.app.inject({ method: "GET", url: `/api/composition/asset-usage${query}`, headers });
  return { status: res.statusCode, body: res.json() as AssetUsagePage & { error?: string }, raw: res.body };
}

async function pageAll(after: number, limit: number): Promise<{ events: AssetUsageWireEvent[]; next: number; raws: string[] }> {
  const events: AssetUsageWireEvent[] = [];
  const raws: string[] = [];
  let cursor = after;
  for (;;) {
    const page = await feed(`?after=${cursor}&limit=${limit}`);
    expect(page.status).toBe(200);
    raws.push(page.raw);
    events.push(...page.body.events);
    if (page.body.events.length < limit) return { events, next: page.body.next, raws };
    cursor = page.body.next;
  }
}

const ledgerIds = () => (rig!.db.prepare("SELECT event_id FROM asset_usage ORDER BY ingest_seq").all() as Array<{ event_id: string }>).map((r) => r.event_id);

describe("asset usage v1 contract", () => {
  it("its fixtures pass and fail the reference validators as named", () => {
    for (const kind of ["valid", "invalid"] as const) {
      const dir = join(ASSET_USAGE_CONTRACT_DIR, "fixtures", kind);
      const names = readdirSync(dir);
      expect(names.some((n) => n.startsWith("event-"))).toBe(true);
      expect(names.some((n) => n.startsWith("page-"))).toBe(true);
      for (const name of names) {
        const body = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
        const result = name.startsWith("page") ? validateAssetUsagePage(body) : validateAssetUsageEvent(body);
        expect([name, result.ok]).toEqual([name, kind === "valid"]);
      }
    }
  });

  it("a page over 500 events is invalid", () => {
    const one = JSON.parse(readFileSync(join(ASSET_USAGE_CONTRACT_DIR, "fixtures", "valid", "event-invoked.json"), "utf8")) as AssetUsageWireEvent;
    const events = Array.from({ length: 501 }, (_, i) => ({ ...one, eventId: `au1_${i.toString(16).padStart(64, "0")}`, seq: i + 1 }));
    expect(validateAssetUsagePage({ schemaVersion: "1.0", events, next: 501 }).ok).toBe(false);
    expect(validateAssetUsagePage({ schemaVersion: "1.0", events: events.slice(0, 500), next: 500 }).ok).toBe(true);
  });

  it("is API 2.7, telemetry.read is observability, and the browser may go without it", () => {
    expect(CONTROL_PLANE_API_VERSION).toBe("2.7");
    expect(OBSERVABILITY_CAPABILITIES).toContain("telemetry.read");
    expect(BROWSER_OPTIONAL_CAPABILITIES).toEqual(["telemetry.read"]);
    expect([...COMMAND_CAPABILITIES, ...INGEST_CAPABILITIES]).not.toContain("telemetry.read");
  });
});

describe("GET /api/composition/asset-usage", () => {
  it("serves the ledger in ingest order as v1 pages; paging by `after` is stable when rows land between pages", async () => {
    rig = await bootRig();
    await runComposed();
    await runComposed();
    const firstIds = ledgerIds();
    expect(firstIds.length).toBe(4); // two sessions × (skill, fragment)

    const page1 = await feed("?after=0&limit=3");
    expect(page1.status).toBe(200);
    expect(validateAssetUsagePage(page1.body).ok).toBe(true);
    expect(page1.body.events.map((e) => e.eventId)).toEqual(firstIds.slice(0, 3));
    expect(page1.body.next).toBe(page1.body.events.at(-1)!.seq);

    // A third session lands between pages: the cursor neither skips nor repeats.
    await runComposed();
    const rest = await pageAll(page1.body.next, 3);
    const seen = [...page1.body.events.map((e) => e.eventId), ...rest.events.map((e) => e.eventId)];
    expect(seen).toEqual(ledgerIds());
    expect(new Set(seen).size).toBe(6);
    expect(seen.slice(0, 4)).toEqual(firstIds);

    // At the end: an empty page keeps the cursor.
    const tail = await feed(`?after=${rest.next}`);
    expect(tail.body).toEqual({ schemaVersion: "1.0", events: [], next: rest.next });

    // The event is the plane's wire shape: no ledger internals.
    const event = page1.body.events[0]!;
    expect(Object.keys(event).sort()).toEqual([
      "assetDigest", "assetId", "assetKind", "at", "attached", "attributionMethod", "compositionRevisionId", "deriverVersion", "eventId",
      "fidelity", "harness", "invocation", "schemaVersion", "seq", "sessionId", "sessionOutcome", "taskId", "validation", "verificationPassed",
    ]);
    expect(event.invocation).toEqual({ method: "not_observable", count: null, failed: null });
  });

  it("maps a tool_event row's counts and serves it unchanged on every read", async () => {
    rig = await bootRig();
    const taskId = await runComposed();
    const s = rig.db.prepare("SELECT session_id, composition_revision_id FROM asset_usage WHERE task_id = ? LIMIT 1").get(taskId) as { session_id: string; composition_revision_id: string };
    // Stands in for an S2 row: an MCP server invoked three times, one failed.
    rig.db.prepare(
      `INSERT INTO asset_usage VALUES (?, (SELECT MAX(ingest_seq) + 1 FROM asset_usage), ?, ?, ?, 'mcp_server', 'github-mcp', ?, 'claude-code', 'full', 1,
        'runtime_confirmed', 'tool_event', 3, 1, 'success', NULL, 'co-occurrence/v1', 1, 'sha256:internal', '2030-01-01T00:00:00.000Z')`,
    ).run(`au1_${"e".repeat(64)}`, s.composition_revision_id, s.session_id, taskId, `sha256:${"1".repeat(64)}`);
    const first = await feed("?after=0");
    const mcp = first.body.events.find((e) => e.assetKind === "mcp_server")!;
    expect(mcp).toMatchObject({ attached: true, validation: "runtime_confirmed", invocation: { method: "tool_event", count: 3, failed: 1 }, verificationPassed: null });
    expect(first.raw).not.toContain("sha256:internal");
    expect((await feed("?after=0")).raw).toBe(first.raw);
  });

  it("bounds limit and after: 0, 501 and non-integers are 400; 1 and 500 are served", async () => {
    rig = await bootRig();
    await runComposed();
    for (const q of ["?limit=0", "?limit=501", "?limit=-1", "?limit=1.5", "?limit=abc", "?limit=", "?limit=01", "?after=-1", "?after=x", "?after=1e3", "?after=99999999999999999"]) {
      const res = await feed(q);
      expect([q, res.status]).toEqual([q, 400]);
      expect(res.body.error).toMatch(/must be an integer/);
    }
    expect((await feed("?limit=1")).body.events).toHaveLength(1);
    expect((await feed("?limit=500")).body.events).toHaveLength(2);
    expect((await feed("")).body.events).toHaveLength(2);
  });

  it("needs telemetry.read: a pre-2.7 credential and an import-only credential get 403, none at all 401", async () => {
    rig = await bootRig();
    await runComposed();
    expect((await feed("", credentialWith(PRE_27))).status).toBe(403);
    expect((await feed("", credentialWith(["usage.write"]))).status).toBe(403);
    const anon = await rig.built.app.inject({ method: "GET", url: "/api/composition/asset-usage" });
    expect(anon.statusCode).toBe(401);
    // Rotated with --capabilities: the feed opens.
    const rotated = credentialWith([...PRE_27, "telemetry.read"]);
    expect((await feed("", rotated)).status).toBe(200);
    expect((await feed("", credentialWith(["telemetry.read"]))).status).toBe(200);
  });

  it("no page carries a FAKE value, a hostname, an absolute path or a secret", async () => {
    rig = await bootRig();
    await runComposed();
    await runComposed(`${GOAL} with FAKE-marker-not-real in the goal`);
    const { raws } = await pageAll(0, 1);
    expect(raws.length).toBeGreaterThan(3);
    for (const raw of raws) {
      expect(raw).not.toMatch(/FAKE/i);
      expect(raw).not.toContain("fake-host-s6");
      expect(raw).not.toContain(rig.root);
      expect(raw).not.toContain(tmpdir());
      expect(raw).not.toContain(COCKPIT_TOKEN);
      expect(raw).not.toMatch(/"\/|[A-Za-z]:\\\\|~\//);
      expect(raw).not.toMatch(/body_?digest/i);
      expect(validateAssetUsagePage(JSON.parse(raw)).ok).toBe(true);
    }
  });
});
