/**
 * Autopilot state v1 (docs/contracts/autopilot-state-v1.md, API 2.21): `GET /api/autopilot/state`
 * serves a redacted, schema-validated projection of the autopilot readers, under `tasks.read`.
 * Every secret here is FAKE-*-not-real.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { COMMAND_CAPABILITIES, CONTROL_PLANE_API_VERSION, INGEST_CAPABILITIES, OBSERVABILITY_CAPABILITIES, type AutopilotStateV1 } from "@agent-plane/core";
import { atomicWriteCredential, credentialPath, readCredential } from "../src/auth/credential-file.js";
import { AUTOPILOT_STATE_CONTRACT_DIR, registerAutopilotStateRoute, validateAutopilotState, type AutopilotStateDeps } from "../src/modules/autopilot-state.js";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

const T0 = Date.parse("2030-01-01T23:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });

function credentialWith(capabilities: readonly string[]): { authorization: string } {
  const path = credentialPath(rig!.config.dir);
  const file = readCredential(path);
  const next = { kid: `k_${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities: [...capabilities], createdAt: new Date().toISOString(), notAfter: null };
  file.secrets.push(next);
  atomicWriteCredential(path, file);
  return { authorization: `Bearer ${next.secret}` };
}
async function state(headers: Record<string, string> = rig!.auth()) {
  const res = await rig!.built.app.inject({ method: "GET", url: "/api/autopilot/state", headers });
  return { status: res.statusCode, body: res.json() as AutopilotStateV1 & { error?: string }, raw: res.body };
}

describe("autopilot state v1 contract", () => {
  it("its fixtures pass and fail the schema as named", () => {
    for (const kind of ["valid", "invalid"] as const) {
      for (const name of readdirSync(join(AUTOPILOT_STATE_CONTRACT_DIR, "fixtures", kind))) {
        const body = JSON.parse(readFileSync(join(AUTOPILOT_STATE_CONTRACT_DIR, "fixtures", kind, name), "utf8"));
        expect([name, validateAutopilotState(body).ok]).toEqual([name, kind === "valid"]);
      }
    }
    expect(readdirSync(join(AUTOPILOT_STATE_CONTRACT_DIR, "fixtures", "valid")).length).toBeGreaterThanOrEqual(3);
    expect(CONTROL_PLANE_API_VERSION).toBe("2.21");
  });
});

describe("GET /api/autopilot/state", () => {
  it("serves the stopped plane, then a running attempt, each valid against v1 and agreeing with GET /api/autopilot", async () => {
    let instant = T0;
    rig = await bootRig({ now: () => new Date(instant), autopilotHostGate: () => ({ ok: true }) });
    const first = await state();
    expect(first.status).toBe(200);
    expect(validateAutopilotState(first.body)).toMatchObject({ ok: true });
    expect(first.body).toMatchObject({ schemaVersion: "1.0", observedAt: at(T0), status: "stopped", window: null, currentAttempt: null, recentAttempts: [], openExternals: 0 });
    expect(first.body.settingProblems.map((p) => p.setting)).toContain("execution.agentUser");

    const ap = rig.built.autopilot;
    const w = ap.addWindow({ opensAt: at(T0 - MIN), closesAt: at(T0 + 60 * MIN), maxItems: 2 }, "op_test");
    ap.attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
    const sha = execFileSync("git", ["-C", rig.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const reserved = ap.reserve({ itemId: "cockpit-autopilot-view", reservationId: "res-1", reservationSha: sha });
    // `halt` only stops a plane that is not already stopped; the start path's settings are not under test here.
    rig.db.prepare("UPDATE autopilot_state SET status = 'running' WHERE id = 1").run();
    ap.halt("github-auth: token=FAKE-secret-not-real read from /home/FAKE/.agent-plane/github-token at https://api.github.com/user");
    instant = T0 + MIN;

    const second = await state();
    expect(second.status).toBe(200);
    expect(validateAutopilotState(second.body)).toMatchObject({ ok: true });
    expect(second.body.observedAt).toBe(at(T0 + MIN));
    expect(second.body.window).toEqual({ id: w.id, opensAt: w.opensAt, closesAt: w.closesAt, maxItems: 2, charged: 0, exhaustedByRestore: false });
    expect(second.body.billingAttestation).toMatchObject({ current: true });
    expect(second.body.currentAttempt).toMatchObject({ id: reserved.id, itemId: "cockpit-autopilot-view", attemptNo: 1, state: "reserving", final: false });
    expect(second.body.recentAttempts.map((a) => a.id)).toEqual([reserved.id]);
    expect(second.body.stopReason).toMatch(/^github-auth: (token=)?\[REDACTED\] read from \[path\] at \[url\]$/);
    for (const leak of ["FAKE-secret-not-real", "/home/FAKE", "api.github.com", "res-1", sha]) expect([leak, second.raw.includes(leak)]).toEqual([leak, false]);

    // Same facts as the plane's own read: nothing recomputed.
    const legacy = (await rig.built.app.inject({ method: "GET", url: "/api/autopilot", headers: rig.auth() })).json() as { status: string; attempt: { id: string; state: string }; window: { id: string } };
    expect([second.body.status, second.body.currentAttempt?.id, second.body.currentAttempt?.state, second.body.window?.id]).toEqual([legacy.status, legacy.attempt.id, legacy.attempt.state, legacy.window.id]);
  });

  it("needs tasks.read only: no credential is 401, a credential without it is 403, tasks.read alone is 200", async () => {
    rig = await bootRig();
    expect((await state({})).status).toBe(401);
    const noRead = credentialWith([...OBSERVABILITY_CAPABILITIES.filter((c) => c !== "tasks.read"), ...COMMAND_CAPABILITIES, ...INGEST_CAPABILITIES]);
    expect((await state(noRead)).status).toBe(403);
    const onlyRead = await state(credentialWith(["tasks.read"]));
    expect(onlyRead.status).toBe(200);
    expect(validateAutopilotState(onlyRead.body).ok).toBe(true);
    expect((await state({ authorization: "Bearer FAKE-credential-not-real" })).status).toBe(401);
  });

  it("a snapshot that fails its own contract is a 500 and never sent", async () => {
    const app = Fastify();
    const deps: AutopilotStateDeps = {
      autopilot: { status: () => ({ status: "running", updatedAt: at(T0), window: null, nextWindowOpensAt: null, attempt: null, billingAttestation: null, settings: [] }), windows: () => [], attempts: () => [], externals: () => [] },
      dispatcher: { status: () => ({ problems: [], inFlight: [], selection: [{ itemId: "x", status: "not-a-status" as "queued", reason: "FAKE-leak-not-real" }] }) },
      restore: { status: () => ({ pending: false, reconciling: false }) },
      now: () => new Date(T0),
    } as unknown as AutopilotStateDeps;
    registerAutopilotStateRoute(app, { config: { auth: { require: "tasks.read" } } }, deps);
    const res = await app.inject({ method: "GET", url: "/api/autopilot/state" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("FAKE-leak-not-real");
    await app.close();
  });
});
