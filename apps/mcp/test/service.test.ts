/**
 * apps/mcp against a real plane with the FakeAdapter, a fake OIDC issuer and the official MCP SDK
 * client (docs/adr/mcp-connector.md, "Acceptance cases", C2 1–9). No tunnel, no network beyond loopback.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CONTRACT_DIR } from "../src/contract.js";
import { parseConfig } from "../src/config.js";
import { apiVersionAtLeast } from "../src/plane.js";
import {
  DEV_BEARER, LOOPBACK_REDIRECT, OWNER_SUB, WEB_ORIGIN, bootRig, mcpClient, ownerBrowser, ownerTokens, pkce, registerClient, tokenRequest, type Rig,
} from "./harness.js";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const schema = (f: string) => { const s = JSON.parse(readFileSync(join(CONTRACT_DIR, f), "utf8")) as Record<string, unknown>; return ajv.compile(s); };
const out = {
  list_tasks: schema("list_tasks.output.schema.json"), get_task: schema("get_task.output.schema.json"),
  create_task: schema("create_task.output.schema.json"), start_task: schema("start_task.output.schema.json"),
};
const toolError = schema("tool-error.schema.json");
/** structuredContent on success; on isError, the tool-error object carried as JSON in the second text block. */
const sc = (r: unknown) => {
  const x = r as { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> };
  return x.isError ? JSON.parse(x.content[1]!.text) as Record<string, unknown> : x.structuredContent!;
};
const isErr = (r: unknown) => (r as { isError?: boolean }).isError === true;
const planeTasks = (rig: Rig) => (rig.planeDb.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const planeRuns = (rig: Rig) => (rig.planeDb.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;

let rig: Rig;
beforeAll(async () => { rig = await bootRig(); });
afterAll(async () => { await rig?.close(); });

describe("resource server (C2 1, 4, 8)", () => {
  it("answers an unauthenticated /mcp with 401 and resource_metadata; metadata documents parse", async () => {
    const res = await fetch(`${rig.config.publicUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain(`resource_metadata="${rig.config.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain('scope="aos.tasks.read aos.tasks.create aos.tasks.start"');
    const prm = await (await fetch(`${rig.config.publicUrl}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: `${rig.config.publicUrl}/mcp`, authorization_servers: [rig.config.publicUrl] });
    const asm = await (await fetch(`${rig.config.publicUrl}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(asm).toMatchObject({ issuer: rig.config.publicUrl, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
    expect(asm.grant_types_supported).not.toContain("implicit");
  });

  it("refuses an unknown or expired token with 401 invalid_token", async () => {
    const res = await fetch(`${rig.config.publicUrl}/mcp`, { method: "POST", headers: { authorization: "Bearer FAKE-token-not-real", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("refuses a present Origin, a wrong Host and any path but /mcp", async () => {
    const { access } = await ownerTokens(rig);
    const withOrigin = await fetch(`${rig.config.publicUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${access}`, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(withOrigin.status).toBe(403);
    const http = await import("node:http");
    const wrongHost = await new Promise<number>((resolve) => {
      const req = http.request(`${rig.config.publicUrl}/mcp`, { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${access}` } }, (r) => { r.resume(); resolve(r.statusCode!); });
      req.end("{}");
    });
    expect(wrongHost).toBe(421);
    expect((await fetch(`${rig.config.publicUrl}/api/tasks`)).status).toBe(404);
  });

  it("refuses a non-loopback bind and a non-https public origin at config time", () => {
    const base = { listen: { host: "127.0.0.1", port: 1 }, publicUrl: "https://mcp.example", plane: { url: "http://127.0.0.1:2", credentialFile: "/x" }, repos: { a: "/r" }, owner: { issuer: "https://accounts.google.com", subject: "s" }, oidc: { issuer: "https://accounts.google.com", clientId: "c", clientSecretFile: "/s" }, stateDb: "/db" };
    expect(() => parseConfig(base)).not.toThrow();
    expect(() => parseConfig({ ...base, listen: { host: "0.0.0.0", port: 1 } })).toThrow(/refuses any other bind/);
    expect(() => parseConfig({ ...base, publicUrl: "http://mcp.example" })).toThrow(/https/);
    expect(() => parseConfig({ ...base, plane: { url: "http://10.0.0.2:1", credentialFile: "/x" } })).toThrow(/loopback/);
    expect(() => parseConfig({ ...base, oidc: { ...base.oidc, issuer: "https://other.example" } })).toThrow(/must equal owner.issuer/);
  });
});

describe("owner login, consent and tokens (C2 2, 3, 4)", () => {
  const base = () => rig.config.publicUrl;
  const authorizeParams = (clientId: string, extra: Record<string, string> = {}) => ({
    response_type: "code", client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, code_challenge: pkce().challenge,
    code_challenge_method: "S256", state: "FAKE-state-not-real", resource: `${base()}/mcp`, ...extra,
  });

  it("issues tokens to the owner (iss, sub) through code + PKCE, with iss in the response", async () => {
    const t = await ownerTokens(rig);
    expect(t.access).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const mcp = await mcpClient(`${base()}/mcp`, t.access);
    const tools = await mcp.client.listTools();
    expect(tools.tools.map((x) => x.name).sort()).toEqual(["create_task", "get_task", "list_tasks", "start_task"]);
    await mcp.close();
  });

  it("refuses another subject with the owner's email, and a wrong issuer", async () => {
    const { body } = await registerClient(base());
    rig.issuer.loginAs = { sub: "FAKE-other-sub-not-real", email: "owner@example.invalid" };
    const other = await ownerBrowser(rig, authorizeParams(body.client_id as string), { consent: "approve" });
    expect(other.status).toBe(403);
    expect(other.html).toContain("not the owner");
    rig.issuer.loginAs = { sub: OWNER_SUB, iss: "https://accounts.google.com" };
    const wrongIss = await ownerBrowser(rig, authorizeParams(body.client_id as string), { consent: "approve" });
    expect(wrongIss.status).toBe(403);
    rig.issuer.loginAs = { sub: OWNER_SUB };
    expect(rig.logs.filter((l) => l.event === "oauth.login").map((l) => l.outcome)).toEqual(expect.arrayContaining(["not_owner", "token_invalid"]));
  });

  it("refuses redirect URIs outside the allowlist at registration and at authorize", async () => {
    expect((await registerClient(base(), { redirect_uris: ["https://evil.example/cb"] })).status).toBe(400);
    const { body } = await registerClient(base());
    const r = await ownerBrowser(rig, authorizeParams(body.client_id as string, { redirect_uri: "http://127.0.0.1:9/other" }));
    expect(r.status).toBe(400);
    expect(r.html).toContain("not registered");
  });

  it("supports CIMD clients (document fetched, client_id must match) and Claude's callback", async () => {
    const cimdId = "https://client.example.org/oauth/metadata.json";
    const docs: Record<string, unknown> = {
      [cimdId]: { client_id: cimdId, client_name: "Claude (test)", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" },
    };
    const cimdRig = await bootRig({ deps: { fetchClientMetadata: async (u) => docs[u] } });
    try {
      const b = cimdRig.config.publicUrl;
      const { verifier, challenge } = pkce();
      const params = { response_type: "code", client_id: cimdId, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: `${b}/mcp` };
      const back = await ownerBrowser(cimdRig, params, { consent: "approve" });
      expect(back.code).toBeDefined();
      expect(back.iss).toBe(b);
      const t = await tokenRequest(b, { grant_type: "authorization_code", code: back.code!, redirect_uri: params.redirect_uri, client_id: cimdId, code_verifier: verifier, resource: `${b}/mcp` });
      expect(t.status).toBe(200);
      // M1: a CIMD client_id is shared by every user of that client app, so consent is asked on every
      // authorization, even for the same scopes, and the page names the publishing host.
      for (const state of ["s2", "s3"]) {
        const again = await ownerBrowser(cimdRig, { ...params, state });
        expect(again.code, state).toBeUndefined();
        expect(again.status).toBe(200);
        expect(again.html).toContain("Allow access to Agent OS?");
        expect(again.html).toContain("client.example.org");
      }
      expect((await ownerBrowser(cimdRig, { ...params, state: "s4" }, { consent: "approve" })).code).toBeDefined();
      // A document whose client_id differs from its URL is refused.
      docs["https://client.example.org/bad.json"] = { client_id: "https://elsewhere.example/x", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
      expect((await ownerBrowser(cimdRig, { ...params, client_id: "https://client.example.org/bad.json" })).status).toBe(400);
      // IP-literal client ids are never fetched.
      expect((await ownerBrowser(cimdRig, { ...params, client_id: "https://10.0.0.1/meta.json" })).status).toBe(400);
    } finally { await cimdRig.close(); }
  });

  it("accepts both loopback IP literals as redirects, never another host", async () => {
    expect((await registerClient(base(), { redirect_uris: ["http://[::1]:53682/callback"] })).status).toBe(201);
    for (const uri of ["http://[::2]:53682/callback", "http://127.0.0.2:53682/callback", "http://[::ffff:7f00:1]:53682/callback"]) expect((await registerClient(base(), { redirect_uris: [uri] })).status, uri).toBe(400);
  });

  it("skips consent for a DCR client that already consented, and asks again for more scopes", async () => {
    const { body } = await registerClient(base());
    const id = body.client_id as string;
    const first = await ownerBrowser(rig, authorizeParams(id, { scope: "aos.tasks.read" }), { consent: "approve" });
    expect(first.code).toBeDefined();
    const again = await ownerBrowser(rig, authorizeParams(id, { scope: "aos.tasks.read" }));
    expect(again.code).toBeDefined();
    const wider = await ownerBrowser(rig, authorizeParams(id, { scope: "aos.tasks.read aos.tasks.start" }));
    expect(wider.status).toBe(200);
    expect(wider.html).toContain("Allow access to Agent OS?");
  });

  it("refuses consent without the exact Origin, and denial returns access_denied", async () => {
    const { body } = await registerClient(base());
    const csrfFail = await ownerBrowser(rig, authorizeParams(body.client_id as string), { consent: "approve", origin: "https://evil.example" });
    expect(csrfFail.status).toBe(403);
    const { body: b2 } = await registerClient(base());
    const denied = await ownerBrowser(rig, authorizeParams(b2.client_id as string), { consent: "deny" });
    expect(denied.error).toBe("access_denied");
  });

  it("refuses a token request for another resource, a bad verifier and a reused code", async () => {
    const { body } = await registerClient(base());
    const id = body.client_id as string;
    const { verifier, challenge } = pkce();
    const back = await ownerBrowser(rig, { ...authorizeParams(id), code_challenge: challenge }, { consent: "approve" });
    const form = { grant_type: "authorization_code", code: back.code!, redirect_uri: LOOPBACK_REDIRECT, client_id: id, code_verifier: verifier, resource: "https://other.example/mcp" };
    expect((await tokenRequest(base(), form)).body.error).toBe("invalid_target");
    // That redemption spent the code: a second try with the right resource is refused.
    expect((await tokenRequest(base(), { ...form, resource: `${base()}/mcp` })).body.error).toBe("invalid_grant");
    const authOther = await ownerBrowser(rig, authorizeParams(id, { resource: "https://other.example/mcp" }));
    expect(authOther.error).toBe("invalid_target");
  });

  it("rotates refresh tokens and revokes the grant when a spent one is presented", async () => {
    const t = await ownerTokens(rig);
    const r1 = await tokenRequest(base(), { grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.clientId, resource: t.resource });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.refresh);
    const reuse = await tokenRequest(base(), { grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.clientId });
    expect(reuse.body.error).toBe("invalid_grant");
    // The whole grant is gone: the rotated access and refresh tokens no longer work.
    const res = await fetch(`${base()}/mcp`, { method: "POST", headers: { authorization: `Bearer ${r1.body.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect((await tokenRequest(base(), { grant_type: "refresh_token", refresh_token: r1.body.refresh_token!, client_id: t.clientId })).status).toBe(400);
  });

  it("expires access tokens after 15 minutes", async () => {
    let clock = Date.now();
    const clocked = await bootRig({ deps: { now: () => clock } });
    try {
      const t = await ownerTokens(clocked);
      clock += 15 * 60_000 + 1;
      const res = await fetch(`${clocked.config.publicUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access}`, "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
    } finally { await clocked.close(); }
  });

  it("answers 403 insufficient_scope for a tool the grant does not hold", async () => {
    const t = await ownerTokens(rig, "aos.tasks.read");
    const mcp = await mcpClient(`${base()}/mcp`, t.access);
    await expect(mcp.client.callTool({ name: "create_task", arguments: { goal: "x", repo: "dogfood", idempotencyKey: "FAKE-key-0000000001" } })).rejects.toThrow(/403|insufficient_scope/);
    await mcp.close();
  });
});

describe("tools against the plane (C2 5, 6, 7)", () => {
  let call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const t = await ownerTokens(rig);
    const mcp = await mcpClient(`${rig.config.publicUrl}/mcp`, t.access);
    // Real clients list tools first, which arms the SDK's outputSchema validation of every result.
    await mcp.client.listTools();
    call = (name, args) => mcp.client.callTool({ name, arguments: args });
    close = mcp.close;
  });
  afterAll(async () => { await close(); });

  it("lists the four contract tools with their schemas and annotations", async () => {
    const t = await ownerTokens(rig);
    const mcp = await mcpClient(`${rig.config.publicUrl}/mcp`, t.access);
    const { tools } = await mcp.client.listTools();
    const create = tools.find((x) => x.name === "create_task")!;
    expect(create.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(create.inputSchema.required).toEqual(["goal", "repo", "idempotencyKey"]);
    expect(create.outputSchema).toBeDefined();
    await mcp.close();
  });

  it("creates, starts in under 2 s, and reads the run back; outputs validate", async () => {
    const created = await call("create_task", { goal: "Add a typed helper", repo: "dogfood", idempotencyKey: "FAKE-create-0001-not-real" });
    expect(isErr(created)).toBe(false);
    const c = sc(created);
    expect(out.create_task(c), JSON.stringify(out.create_task.errors)).toBe(true);
    expect(c).toMatchObject({ state: "CREATED", repo: "dogfood", replayed: false, webLink: `${WEB_ORIGIN}/#/missions/${String(c.taskId)}` });
    const proposal = c.proposal as { assistantId: string; compositionDigest: string | null };
    expect(proposal.assistantId).toBe("fake-claude");

    const t0 = Date.now();
    const started = await call("start_task", { taskId: c.taskId, idempotencyKey: "FAKE-start-0001-not-real", confirm: { assistantId: proposal.assistantId, compositionDigest: proposal.compositionDigest } });
    const elapsed = Date.now() - t0;
    expect(isErr(started), JSON.stringify(started)).toBe(false);
    expect(out.start_task(sc(started)), JSON.stringify(out.start_task.errors)).toBe(true);
    expect(sc(started)).toMatchObject({ taskId: c.taskId, assistantId: "fake-claude", replayed: false, webLink: c.webLink });
    expect(elapsed).toBeLessThan(2000);

    const got = await call("get_task", { taskId: c.taskId });
    expect(out.get_task(sc(got)), JSON.stringify(out.get_task.errors)).toBe(true);
    expect((sc(got).latestRun as { runId: string }).runId).toBe(sc(started).runId);
    expect(sc(got).webLink).toBe(c.webLink);

    // API 2.17: once the run settles, get_task carries the plane's verification summary, not null.
    const settled = await until(async () => sc(await call("get_task", { taskId: c.taskId })), (x) => (x.stage as { value: string }).value === "done");
    expect(out.get_task(settled), JSON.stringify(out.get_task.errors)).toBe(true);
    expect(settled.pendingApprovals).toBe(0);
    expect(settled.verification).toMatchObject({ runState: "completed" });

    const listed = await call("list_tasks", {});
    expect(out.list_tasks(sc(listed)), JSON.stringify(out.list_tasks.errors)).toBe(true);
    expect((sc(listed).tasks as Array<{ taskId: string }>).map((x) => x.taskId)).toContain(c.taskId);
  });

  it("replays create and start with the same key, and refuses a changed input", async () => {
    const args = { goal: "Replay me", repo: "dogfood", idempotencyKey: "FAKE-create-0002-not-real" };
    const a = sc(await call("create_task", args));
    const tasksBefore = planeTasks(rig);
    const b = sc(await call("create_task", args));
    expect(b).toEqual({ ...a, replayed: true });
    expect(planeTasks(rig)).toBe(tasksBefore);
    const conflict = await call("create_task", { ...args, goal: "Something else" });
    expect(isErr(conflict)).toBe(true);
    expect(sc(conflict)).toMatchObject({ code: "idempotency_conflict", retryable: false });
    expect(toolError(sc(conflict))).toBe(true);

    const s1 = sc(await call("start_task", { taskId: a.taskId, idempotencyKey: "FAKE-start-0002-not-real" }));
    const runsAfterFirst = planeRuns(rig);
    const s2 = sc(await call("start_task", { taskId: a.taskId, idempotencyKey: "FAKE-start-0002-not-real" }));
    expect(s2.replayed).toBe(true);
    expect(s2.runId).toBe(s1.runId);
    expect(planeRuns(rig)).toBe(runsAfterFirst);
    const fresh = await call("start_task", { taskId: a.taskId, idempotencyKey: "FAKE-start-0003-not-real" });
    expect(sc(fresh)).toMatchObject({ code: "invalid_state" });
    expect(toolError(sc(fresh))).toBe(true);
  });

  it("refuses an unknown alias and hides tasks in non-exposed repos, without a plane write", async () => {
    const before = planeTasks(rig);
    const bad = await call("create_task", { goal: "x", repo: "hidden", idempotencyKey: "FAKE-create-0003-not-real" });
    expect(sc(bad)).toMatchObject({ code: "repo_not_allowed" });
    expect(planeTasks(rig)).toBe(before);
    expect(sc(await call("list_tasks", { repo: "hidden" }))).toMatchObject({ code: "repo_not_allowed" });

    // A task created by the full CLI credential in the allowlisted but non-exposed repo.
    const hiddenTask = rig.plane.tasks.create({ goal: "private", constraints: [], repoPath: rig.hidden });
    const runsBefore = planeRuns(rig);
    expect(sc(await call("get_task", { taskId: hiddenTask.taskId }))).toMatchObject({ code: "not_found" });
    expect(sc(await call("get_task", { taskId: "AG-doesnotexist" }))).toMatchObject({ code: "not_found" });
    expect(sc(await call("start_task", { taskId: hiddenTask.taskId, idempotencyKey: "FAKE-start-0004-not-real" }))).toMatchObject({ code: "not_found" });
    expect(planeRuns(rig)).toBe(runsBefore);
    expect((sc(await call("list_tasks", { limit: 50 })).tasks as Array<{ taskId: string }>).map((x) => x.taskId)).not.toContain(hiddenTask.taskId);
  });

  it("refuses arguments outside the input schema as invalid_input", async () => {
    const r = await call("create_task", { goal: "x", repo: "dogfood", idempotencyKey: "short" });
    expect(sc(r)).toMatchObject({ code: "invalid_input" });
    const extra = await call("create_task", { goal: "x", repo: "dogfood", idempotencyKey: "FAKE-create-0009-not-real", repoPath: "/etc" });
    expect(sc(extra)).toMatchObject({ code: "invalid_input" });
  });

  it("answers route_changed when confirm names an assistant that no longer routes", async () => {
    const c = sc(await call("create_task", { goal: "Route check", repo: "dogfood", idempotencyKey: "FAKE-create-0004-not-real" }));
    const r = await call("start_task", { taskId: c.taskId, idempotencyKey: "FAKE-start-0005-not-real", confirm: { assistantId: "fake-other" } });
    expect(sc(r)).toMatchObject({ code: "route_changed" });
    expect(toolError(sc(r))).toBe(true);
  });
});

describe("get_task approvals and verification from the plane read (API 2.17)", () => {
  it("counts a pending Harness approval, then drops it once answered, and serves the verification", async () => {
    const prompting = await bootRig({ approvalMode: "prompt-on-escalation" });
    try {
      const t = await ownerTokens(prompting);
      const mcp = await mcpClient(`${prompting.config.publicUrl}/mcp`, t.access);
      await mcp.client.listTools();
      const call = (name: string, args: Record<string, unknown>) => mcp.client.callTool({ name, arguments: args });
      const c = sc(await call("create_task", { goal: "Needs sign-off [FAKE:APPROVAL]", repo: "dogfood", idempotencyKey: "FAKE-create-0101-not-real" }));
      const proposal = c.proposal as { assistantId: string; compositionDigest: string | null };
      expect(isErr(await call("start_task", { taskId: c.taskId, idempotencyKey: "FAKE-start-0101-not-real", confirm: { assistantId: proposal.assistantId, compositionDigest: proposal.compositionDigest } }))).toBe(false);

      const waitingResult = await until(() => call("get_task", { taskId: c.taskId }), (r) => sc(r).pendingApprovals === 1);
      const waiting = sc(waitingResult);
      expect(out.get_task(waiting), JSON.stringify(out.get_task.errors)).toBe(true);
      expect(waiting).toMatchObject({ stage: { value: "needs-you", rule: "awaiting-approval" }, verification: null });
      expect((waitingResult as { content: Array<{ text: string }> }).content[0]!.text).toContain("1 approval waiting.");

      // The owner answers on the Web; the MCP process never sees the approval itself.
      const requestId = (prompting.planeDb.prepare("SELECT a.provider_request_id AS id FROM approvals a JOIN runs r ON r.id = a.session_id WHERE r.task_id = ?").get(c.taskId) as { id: string }).id;
      await prompting.plane.orchestrator.respondApproval(String(c.taskId), requestId, true);
      const done = sc(await until(() => call("get_task", { taskId: c.taskId }), (r) => (sc(r).stage as { value: string }).value === "done"));
      expect(out.get_task(done), JSON.stringify(out.get_task.errors)).toBe(true);
      expect(done.pendingApprovals).toBe(0);
      expect(done.verification).toMatchObject({ runState: "completed" });
      await mcp.close();
    } finally { await prompting.close(); }
  });

  it("needs plane API 2.17 or later", () => {
    expect(apiVersionAtLeast("2.16")).toBe(false);
    expect(apiVersionAtLeast("2.17")).toBe(true);
    expect(apiVersionAtLeast("3.0")).toBe(false);
  });
});

describe("dev bearer listener, rate limits, boot checks and logs (C2 8, 9)", () => {
  it("accepts only the configured FAKE dev bearer on its own loopback port", async () => {
    const mcp = await mcpClient(`${rig.service.devUrl!}/mcp`, DEV_BEARER);
    expect((await mcp.client.listTools()).tools).toHaveLength(4);
    await mcp.close();
    const res = await fetch(`${rig.service.devUrl!}/mcp`, { method: "POST", headers: { authorization: "Bearer FAKE-wrong-not-real", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    // The OAuth endpoints do not exist on the dev listener.
    expect((await fetch(`${rig.service.devUrl!}/oauth/token`, { method: "POST" })).status).toBe(404);
  });

  it("rate-limits creates per grant with rate_limited and retryAfterSeconds", async () => {
    const limited = await bootRig({ mcp: { rateLimits: { createsPerHour: 1 } } });
    try {
      const t = await ownerTokens(limited);
      const mcp = await mcpClient(`${limited.config.publicUrl}/mcp`, t.access);
      await mcp.client.callTool({ name: "create_task", arguments: { goal: "a", repo: "dogfood", idempotencyKey: "FAKE-create-0005-not-real" } });
      const r = await mcp.client.callTool({ name: "create_task", arguments: { goal: "b", repo: "dogfood", idempotencyKey: "FAKE-create-0006-not-real" } });
      expect(sc(r)).toMatchObject({ code: "rate_limited", retryable: true });
      expect(toolError(sc(r))).toBe(true);
      await mcp.close();
    } finally { await limited.close(); }
  });

  it("rate-limits the OAuth endpoints per client address", async () => {
    const limited = await bootRig({ mcp: { rateLimits: { oauthPerMinutePerAddress: 2 } } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await registerClient(limited.config.publicUrl)).status);
      expect(statuses).toEqual([201, 201, 429]);
    } finally { await limited.close(); }
  });

  it("refuses to boot without a plane Web origin, with an unknown alias, or with a wide credential", async () => {
    await expect(bootRig({ planeWebOrigin: null })).rejects.toThrow(/webOrigin/);
    await expect(bootRig({ mcp: { repos: { other: "/nowhere/else" } } })).rejects.toThrow(/repoAllowlist/);
    await expect(bootRig({ credentialCapabilities: ["tasks.read", "tasks.create", "tasks.start", "commands.write"] })).rejects.toThrow(/more than the MCP set \(commands.write\)/);
  });

  it("never logs a token, code, cookie or the plane credential", async () => {
    const t = await ownerTokens(rig);
    const planeSecret = JSON.parse(readFileSync(rig.config.plane.credentialFile, "utf8")).secrets.at(-1).secret as string;
    const text = JSON.stringify(rig.logs);
    for (const secret of [t.access, t.refresh, planeSecret, DEV_BEARER, "FAKE-google-code", "aos_mcp_browser", "FAKE-oidc-secret-not-real"]) {
      expect(text).not.toContain(secret);
    }
    expect(rig.logs.some((l) => l.event === "http" && l.path === "/oauth/token")).toBe(true);
  });

  it("revokeAll ends every grant", async () => {
    const t = await ownerTokens(rig);
    rig.service.store.revokeAll();
    const res = await fetch(`${rig.config.publicUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});
