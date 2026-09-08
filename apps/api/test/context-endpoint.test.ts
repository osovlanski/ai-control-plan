/**
 * M14 K9 — `readTaskContext` truth rules and `GET /api/tasks/:id/context` auth.
 *
 * Two truthful outcomes only: KNOWN (occupancy + window + source + freshness) or
 * UNAVAILABLE. No percentage without a fresh, known effective window. The legacy
 * execution path reports UNAVAILABLE explicitly. A stale observation renders
 * stale and never masquerades as a live pressure reading.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityManifest } from "@agent-plane/core";
import { buildContextObservation } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { readTaskContext } from "../src/modules/context.js";
import {
  atomicWriteCredential,
  credentialPath,
  readCredential,
} from "../src/auth/credential-file.js";
import { randomBytes } from "node:crypto";

const NOW = new Date("2026-09-08T10:00:00.000Z");
const nowFn = () => NOW;

const CAP_PROVIDER: NonNullable<CapabilityManifest["context"]> = {
  occupancy: "provider-reported",
  effectiveWindow: "provider-reported",
  compact: "none",
  autoManagement: "provider",
  autoManagementDetail: "Claude Code auto-compaction",
  observesAutoCompaction: true,
};
const CAP_UNAVAILABLE: NonNullable<CapabilityManifest["context"]> = {
  occupancy: "unavailable",
  effectiveWindow: "unavailable",
  compact: "none",
  autoManagement: "provider",
  autoManagementDetail: "Codex manages its own context",
  observesAutoCompaction: false,
};

describe("readTaskContext", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "k9-ctx-read-"));
    db = openDb(join(dir, "t.db"));
    db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','anthropic')").run();
    db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seedRun = (
    id: string,
    opts: { legacy?: boolean; sessionState?: string; modelResolved?: string | null } = {},
  ) => {
    db.prepare(
      `INSERT INTO runs (id, task_id, assistant_id, state, session_state, execution_request_id,
                         model_resolved, model_resolved_source, started_at)
       VALUES (?, 'AG-1', 'a1', 'ACTIVE', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.sessionState ?? "RUNNING",
      opts.legacy ? null : `erq_${id}`,
      opts.modelResolved ?? null,
      opts.modelResolved ? "run.started" : null,
      NOW.toISOString(),
    );
  };
  const seedEvent = (runId: string, seq: number, type: string, payload: unknown, ts = NOW.toISOString()) =>
    db
      .prepare("INSERT INTO events (run_id, seq, ts, type, summary, payload) VALUES (?,?,?,?,?,?)")
      .run(runId, seq, ts, type, "s", JSON.stringify(payload));

  const obs = (over: Partial<Parameters<typeof buildContextObservation>[0]> = {}) =>
    buildContextObservation(
      { occupancyTokens: 82_000, occupancySource: "provider-reported", effectiveWindowTokens: 180_000, ...over },
      { sessionId: "es_1", sequence: 1, now: NOW.toISOString() },
    );

  const read = (over: Partial<Parameters<typeof readTaskContext>[2]> = {}) =>
    readTaskContext(db, "AG-1", { now: nowFn, capabilityFor: () => CAP_PROVIDER, ...over });

  it("KNOWN: fresh observation on a live session yields occupancy + window + pressure + live", () => {
    seedRun("r1");
    seedEvent("r1", 1, "context.observed", obs());
    const res = read();
    expect(res.status).toBe("known");
    expect(res.observation).toMatchObject({
      occupancyTokens: 82_000,
      effectiveWindowTokens: 180_000,
      effectiveWindowSource: "provider-reported",
      freshness: "live",
    });
    expect(res.observation!.pressure).toBeCloseTo(82_000 / 180_000, 4);
  });

  it("PARTIAL: occupancy known but window unknown → tokens, no percentage", () => {
    seedRun("r1");
    seedEvent("r1", 1, "context.observed", obs({ effectiveWindowTokens: undefined }));
    const res = read();
    expect(res.status).toBe("known");
    expect(res.observation!.occupancyTokens).toBe(82_000);
    expect(res.observation!.pressure).toBeUndefined();
    expect(res.observation!.effectiveWindowSource).toBe("unavailable");
  });

  it("STALE by age: an old observation on a live session renders stale with no pressure", () => {
    seedRun("r1");
    seedEvent("r1", 1, "context.observed", obs(), new Date(NOW.getTime() - 120_000).toISOString());
    const res = read();
    expect(res.observation!.freshness).toBe("stale");
    expect(res.observation!.pressure).toBeUndefined();
  });

  it("STALE by terminal: a fresh observation on a settled session still renders stale", () => {
    seedRun("r1", { sessionState: "COMPLETED" });
    seedEvent("r1", 1, "context.observed", obs());
    const res = read();
    expect(res.observation!.freshness).toBe("stale");
    expect(res.observation!.pressure).toBeUndefined();
  });

  it("LEGACY path: explicit unavailable, never synthesised parity", () => {
    seedRun("r1", { legacy: true });
    seedEvent("r1", 1, "context.observed", obs());
    const res = read();
    expect(res.status).toBe("unavailable");
    expect(res.reason).toBe("legacy execution path");
  });

  it("no execution session → unavailable", () => {
    expect(read().status).toBe("unavailable");
    expect(read().reason).toContain("no execution session");
  });

  it("provider without a verified occupancy source (Codex-shaped) → unavailable, honest reason", () => {
    seedRun("r1");
    const res = read({ capabilityFor: () => CAP_UNAVAILABLE });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toContain("does not expose live context occupancy");
    expect(res.capability).toEqual(CAP_UNAVAILABLE);
  });

  it("reports provider auto-compaction as observed, never as an Agentic OS action", () => {
    seedRun("r1");
    seedEvent("r1", 1, "context.compaction.observed", { trigger: "auto", requestedByPlane: false });
    seedEvent("r1", 2, "context.observed", obs({ occupancyTokens: 40_000 }));
    const res = read();
    expect(res.autoCompaction).toMatchObject({ observed: true, count: 1, trigger: "auto" });
  });

  it("advertised maximum falls back to the K7 catalog ONLY when the resolved model is known", () => {
    seedRun("r1", { modelResolved: "claude-x" });
    seedEvent("r1", 1, "context.observed", obs({ advertisedMaxTokens: undefined }));
    const advertisedMaxFor = vi.fn().mockReturnValue(1_000_000);
    const res = read({ advertisedMaxFor });
    expect(advertisedMaxFor).toHaveBeenCalledWith("anthropic", "claude-x");
    expect(res.observation!.advertisedMaxTokens).toBe(1_000_000);
    // effective window is still the provider-reported one, NOT the catalog max.
    expect(res.observation!.effectiveWindowTokens).toBe(180_000);
  });

  it("never guesses an advertised maximum when the resolved model is unknown", () => {
    seedRun("r1", { modelResolved: null });
    seedEvent("r1", 1, "context.observed", obs({ advertisedMaxTokens: undefined }));
    const advertisedMaxFor = vi.fn().mockReturnValue(1_000_000);
    const res = read({ advertisedMaxFor });
    expect(advertisedMaxFor).not.toHaveBeenCalled();
    expect(res.observation!.advertisedMaxTokens).toBeUndefined();
  });
});

describe("GET /api/tasks/:id/context — capability negotiation", () => {
  let home: string;
  let db: Db;
  let config: ResolvedConfig;
  let built: BuiltServer;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "k9-ctx-api-"));
    config = loadConfig({ AGENT_PLANE_HOME: home });
    config.assistants = { "fake-a": { provider: "fake" } };
    db = openDb(config.dbPath);
    built = buildServer({ config, db });
    built.registry.init();
  });
  afterEach(async () => {
    await built.app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const full = () =>
    readCredential(credentialPath(config.dir)).secrets[0]!.secret;
  /** Mint a credential with an explicit capability list (mirrors a pre-K9 credential). */
  const withCaps = (capabilities: string[]) => {
    const file = readCredential(credentialPath(config.dir));
    const next = {
      kid: `k_${randomBytes(4).toString("hex")}`,
      secret: randomBytes(32).toString("base64url"),
      capabilities,
      createdAt: new Date().toISOString(),
      notAfter: null,
    };
    file.secrets.push(next);
    atomicWriteCredential(credentialPath(config.dir), file);
    return next.secret;
  };

  const createTask = async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${full()}` },
      payload: { goal: "observe me" },
    });
    return (res.json() as { taskId: string }).taskId;
  };

  it("a credential carrying context.read is admitted", async () => {
    const id = await createTask();
    const res = await built.app.inject({
      method: "GET",
      url: `/api/tasks/${id}/context`,
      headers: { authorization: `Bearer ${withCaps(["context.read"])}` },
    });
    expect(res.statusCode).toBe(200);
    // No session yet → truthful unavailable, not an error.
    expect(res.json()).toMatchObject({ status: "unavailable" });
  });

  it("a credential minted before K9 (no context.read) fails closed until rotated", async () => {
    const id = await createTask();
    const preK9 = withCaps([
      "tasks.read",
      "events.read",
      "events.stream",
      "routing.read",
      "sessions.read",
      "verification.read",
      "approvals.read",
      "schedules.read",
      "models.read",
      "commands.write",
    ]);
    const res = await built.app.inject({
      method: "GET",
      url: `/api/tasks/${id}/context`,
      headers: { authorization: `Bearer ${preK9}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s for an unknown task before touching context", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: "/api/tasks/AG-nope/context",
      headers: { authorization: `Bearer ${withCaps(["context.read"])}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
