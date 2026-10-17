/**
 * M5: the plane requests a bundle from Cockpit over loopback, validates it against the request,
 * and persists it with its composition revision. Failures are classified and write nothing;
 * there is no local fallback render.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { assembleBundle, BUNDLE_CONTRACT_DIR, type BundleRequest, type BundleResponse } from "../src/bundle-contract.js";
import { COMPOSITION_CONTRACT_DIR, type AgentSpec, type CompositionDecision } from "../src/composition-contract.js";
import {
  BundledComposition, BundleRequestError, bundleRequestFor, CockpitBundleClient, MAX_BUNDLE_RESPONSE_BYTES,
  type AgentSpecDraft, type BundleSource, type BundledCompositionInput,
} from "../src/modules/bundle-request.js";
import { CompositionStore } from "../src/modules/composition.js";

const TOKEN = "FAKE-cockpit-registry-token-not-real-0123456789";
const json = <T>(dir: string, file: string) => JSON.parse(readFileSync(join(dir, "fixtures", file), "utf8")) as T;
const fixtureRequest = () => json<BundleRequest>(BUNDLE_CONTRACT_DIR, "valid/two-skill.request.json");
const fixtureResponse = () => json<BundleResponse>(BUNDLE_CONTRACT_DIR, "valid/two-skill.response.json");

/** The two-skill fixture revision with its bundle-derived fields removed: those come from Cockpit. */
function input(): BundledCompositionInput {
  const spec = json<AgentSpec>(COMPOSITION_CONTRACT_DIR, "valid/two-skill.agent-spec.json");
  const { bundle_digest: _digest, compiler: _compiler, ...context } = spec.context;
  return {
    spec: { ...spec, context } as AgentSpecDraft,
    decision: json<CompositionDecision>(COMPOSITION_CONTRACT_DIR, "valid/two-skill.decision.json"),
    charsPerToken: 3.7,
    tokenBudget: 8000,
  };
}
const on = { enabled: true };
const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

let dir: string;
let db: Db;
let tokenPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bundle-request-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-0001','g','{}','t','t')").run();
  tokenPath = join(dir, "token");
  writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
/** A loopback stand-in for Cockpit's route, so the real fetch, abort and stream paths run. */
async function cockpit(handler: Handler): Promise<{ url: string; requests: Array<{ headers: IncomingMessage["headers"]; body: string; url?: string; method?: string }>; close(): Promise<void> }> {
  const requests: Array<{ headers: IncomingMessage["headers"]; body: string; url?: string; method?: string }> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      requests.push({ headers: req.headers, body, url: req.url, method: req.method });
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("CockpitBundleClient", () => {
  it("posts the request with the bearer token and returns the validated response", async () => {
    const server = await cockpit((_req, _body, res) => send(res, 200, fixtureResponse()));
    try {
      const response = await new CockpitBundleClient(server.url, tokenPath).render(fixtureRequest());
      expect(response).toEqual(fixtureResponse());
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({ method: "POST", url: "/api/v1/registry/bundle" });
      expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(server.requests[0]!.body)).toEqual(fixtureRequest());
    } finally { await server.close(); }
  });

  it.each([
    [400, "bad_request"], [401, "unauthenticated"], [404, "not_found"], [413, "payload_too_large"], [503, "http_error"], [500, "http_error"],
  ] as const)("classifies a %i as %s without reading the body", async (status, reason) => {
    const server = await cockpit((_req, _body, res) => send(res, status, { error: { code: "x", message: `secret-ish ${TOKEN}` } }));
    try {
      const err = await new CockpitBundleClient(server.url, tokenPath).render(fixtureRequest()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundleRequestError);
      expect((err as BundleRequestError).reason).toBe(reason);
      expect((err as Error).message).not.toContain(TOKEN);
    } finally { await server.close(); }
  });

  it("never reads an error body", async () => {
    for (const status of [400, 401, 404, 413, 500]) {
      let cancelled = false;
      const body = new ReadableStream({ pull() { throw new Error("error body was read"); }, cancel() { cancelled = true; } });
      const fetcher = (async () => new Response(body, { status })) as typeof fetch;
      await expect(new CockpitBundleClient("http://127.0.0.1:1", tokenPath, fetcher).render(fixtureRequest())).rejects.toBeInstanceOf(BundleRequestError);
      expect(cancelled, String(status)).toBe(true);
    }
  });

  it("times out a body that stalls after the headers", async () => {
    const server = await cockpit((_req, _body, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
    try {
      await expect(new CockpitBundleClient(server.url, tokenPath, fetch, 100).render(fixtureRequest())).rejects.toMatchObject({ reason: "timeout" });
    } finally { await server.close(); }
  });

  it("rejects a response that echoes the bearer token, even in otherwise valid content", async () => {
    const request = fixtureRequest();
    const echo = assembleBundle({
      request: { ...request, skills: [], memoryBundles: [] },
      rendered: [{ relPath: "CLAUDE.md", content: `token ${TOKEN}` }],
      compiler: { name: "c", version: "1.0.0" },
      included: request.fragments.map((ref) => ({ kind: "fragment" as const, ref, digest: `sha256:${"a".repeat(64)}`, reason: "r" })),
      excluded: [],
    });
    const server = await cockpit((_req, _body, res) => send(res, 200, echo));
    try {
      const err = await new CockpitBundleClient(server.url, tokenPath).render({ ...request, skills: [], memoryBundles: [] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: "invalid_response", detail: "response contains the bearer token" });
      expect((err as Error).message).not.toContain(TOKEN);
    } finally { await server.close(); }
  });

  it("checks for the token before validation, raw or JSON-escaped, so no detail can quote it", async () => {
    const escaped = JSON.stringify({ schemaVersion: TOKEN }).replace(/-/g, "\\u002d");
    for (const body of [JSON.stringify({ schemaVersion: TOKEN }), escaped]) {
      const server = await cockpit((_req, _b, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
      try {
        const err = await new CockpitBundleClient(server.url, tokenPath).render(fixtureRequest()).catch((e: unknown) => e) as BundleRequestError;
        expect(err).toMatchObject({ reason: "invalid_response", detail: "response contains the bearer token" });
        expect(JSON.stringify({ m: err.message, d: err.detail })).not.toContain(TOKEN);
      } finally { await server.close(); }
    }
    expect(escaped).not.toContain(TOKEN);
  });

  it("accepts a conforming bundle at the worst-case encoding under the default cap", async () => {
    const request = { ...fixtureRequest(), skills: [], memoryBundles: [], tokenBudget: 200_000 };
    // 256 KiB of C0 control characters: res.json writes each as \u00XX, 6x on the wire.
    const bundle = assembleBundle({
      request, rendered: [{ relPath: "CLAUDE.md", content: "\u0001".repeat(256 * 1024) }], compiler: { name: "c", version: "1.0.0" },
      included: request.fragments.map((ref) => ({ kind: "fragment" as const, ref, digest: `sha256:${"a".repeat(64)}`, reason: "\u0001".repeat(512) })),
      excluded: [],
    });
    const wire = JSON.stringify(bundle);
    expect(Buffer.byteLength(wire)).toBeGreaterThan(1.5 * 1024 * 1024);
    const server = await cockpit((_req, _b, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(wire); });
    try {
      expect((await new CockpitBundleClient(server.url, tokenPath).render(request)).manifest.bundleDigest).toBe(bundle.manifest.bundleDigest);
    } finally { await server.close(); }
  });

  it("refuses a declared Content-Length over the cap before reading", async () => {
    const server = await cockpit((_req, _body, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(MAX_BUNDLE_RESPONSE_BYTES + 1) });
      res.write("{");
    });
    try {
      await expect(new CockpitBundleClient(server.url, tokenPath).render(fixtureRequest())).rejects.toMatchObject({ reason: "payload_too_large" });
    } finally { await server.close(); }
  });

  it("stops a chunked body as soon as it passes the cap", async () => {
    let written = 0;
    const server = await cockpit((_req, _body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const pump = () => {
        while (written < 8 * 1024 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      res.on("close", () => { written = Infinity; });
      pump();
    });
    try {
      // The default cap, on a body with no Content-Length.
      await expect(new CockpitBundleClient(server.url, tokenPath).render(fixtureRequest()))
        .rejects.toMatchObject({ reason: "payload_too_large" });
    } finally { await server.close(); }
  });

  it("classifies unreachable, timeout, redirects and bodies that are not JSON", async () => {
    const closed = await cockpit(() => {});
    const url = closed.url;
    await closed.close();
    await expect(new CockpitBundleClient(url, tokenPath).render(fixtureRequest())).rejects.toMatchObject({ reason: "unreachable" });

    const slow = await cockpit(() => { /* never answers */ });
    try {
      await expect(new CockpitBundleClient(slow.url, tokenPath, fetch, 50).render(fixtureRequest())).rejects.toMatchObject({ reason: "timeout" });
    } finally { await slow.close(); }

    const redirect = await cockpit((_req, _body, res) => { res.writeHead(307, { location: "http://example.invalid/steal" }); res.end(); });
    try {
      await expect(new CockpitBundleClient(redirect.url, tokenPath).render(fixtureRequest())).rejects.toMatchObject({ reason: "unreachable" });
      expect(redirect.requests).toHaveLength(1);
    } finally { await redirect.close(); }

    const html = await cockpit((_req, _body, res) => { res.writeHead(200); res.end("<html>"); });
    try {
      await expect(new CockpitBundleClient(html.url, tokenPath).render(fixtureRequest())).rejects.toMatchObject({ reason: "invalid_response" });
    } finally { await html.close(); }
  });

  it("rejects a response that fails bundle v1 or does not answer the request", async () => {
    const cases: Array<[string, (r: BundleResponse) => unknown, string]> = [
      ["tampered content", (r) => { r.files[0]!.content += "x"; return r; }, "invalid_response"],
      ["another harness", (r) => { r.manifest.harness = "codex"; return r; }, "invalid_response"],
      ["an inline credential", () => {
        const request = fixtureRequest();
        return assembleBundle({
          request: { ...request, skills: [], memoryBundles: [] },
          rendered: [{ relPath: "CLAUDE.md", content: "key: sk-ant-FAKEnotreal0123456789abcdef0123456789" }],
          compiler: { name: "c", version: "1.0.0" },
          included: request.fragments.map((ref) => ({ kind: "fragment" as const, ref, digest: `sha256:${"a".repeat(64)}`, reason: "r" })),
          excluded: [],
        });
      }, "invalid_response"],
      ["a newer major", (r) => ({ ...r, schemaVersion: "2.0" }), "unsupported_version"],
      ["a newer minor than the request asked for", (r) => ({ ...r, schemaVersion: "1.1" }), "invalid_response"],
    ];
    for (const [name, mutate, reason] of cases) {
      const server = await cockpit((_req, _body, res) => send(res, 200, mutate(fixtureResponse())));
      try {
        await expect(new CockpitBundleClient(server.url, tokenPath).render(fixtureRequest()), name).rejects.toMatchObject({ reason });
      } finally { await server.close(); }
    }
  });

  it("refuses a missing or unsafe token file before any request", async () => {
    let called = 0;
    const fetcher = (async () => { called++; return new Response("{}"); }) as typeof fetch;
    await expect(new CockpitBundleClient("http://127.0.0.1:1", join(dir, "absent"), fetcher).render(fixtureRequest())).rejects.toMatchObject({ reason: "token_file_missing" });
    writeFileSync(join(dir, "loose"), TOKEN, { mode: 0o644 });
    await expect(new CockpitBundleClient("http://127.0.0.1:1", join(dir, "loose"), fetcher).render(fixtureRequest())).rejects.toMatchObject({ reason: "token_file_unsafe" });
    expect(called).toBe(0);
  });

  it("only talks to an http loopback origin", () => {
    for (const url of ["http://example.com:8787", "https://127.0.0.1:8787", "http://10.0.0.1:8787", "http://127.0.0.1.example.com"]) {
      expect(() => new CockpitBundleClient(url, tokenPath), url).toThrow(/loopback/);
    }
    for (const url of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) expect(() => new CockpitBundleClient(url, tokenPath)).not.toThrow();
  });
});

class FakeSource implements BundleSource {
  requests: BundleRequest[] = [];
  constructor(private next: BundleResponse | BundleRequestError) {}
  async render(request: BundleRequest) {
    this.requests.push(request);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

describe("BundledComposition", () => {
  it("is gated on registry.cockpit.enabled: off sends nothing", async () => {
    const source = new FakeSource(fixtureResponse());
    expect(await new BundledComposition(db, source, { enabled: false }).compose(input())).toEqual({ ok: false, reason: "disabled" });
    expect(source.requests).toEqual([]);
  });

  it("codex with selected skills is never final: bundle v1 has no skill path for it", async () => {
    const draft = input();
    draft.spec.harness = "codex";
    const request = bundleRequestFor(draft) as BundleRequest;
    const fragments = request.fragments.map((ref) => ({ kind: "fragment" as const, ref, digest: `sha256:${"a".repeat(64)}`, reason: "r" }));
    const bundle = assembleBundle({
      request, rendered: [{ relPath: "AGENTS.md", content: "# Project context" }], compiler: { name: "c", version: "1.0.0" },
      included: fragments,
      excluded: [
        { kind: "memory_bundle", ref: "mem-example-notes", reason: "over budget" },
        ...request.skills.map((s) => ({ kind: "skill" as const, ref: s.id, reason: "bundle v1 has no skill path for codex" })),
      ],
    });
    const result = await new BundledComposition(db, new FakeSource(bundle), on).compose(draft);
    expect(result).toMatchObject({ ok: false, reason: "not_final" });
    expect((result as { excludedSkills: unknown[] }).excludedSkills).toHaveLength(2);
    expect(count(db, "agent_specs")).toBe(0);
  });

  // The fixture excludes its memory bundle as over budget: a non-skill exclusion is final.
  it("builds the request from the draft, and persists Cockpit's bundle with the revision", async () => {
    const source = new FakeSource(fixtureResponse());
    const result = await new BundledComposition(db, source, on).compose(input());
    expect(source.requests).toEqual([fixtureRequest()]);
    expect(result.ok).toBe(true);
    const stored = new CompositionStore(db).get("CR-0002-1")!;
    expect(stored.bundle.response).toEqual(fixtureResponse());
    expect(stored.spec.context.bundle_digest).toBe(fixtureResponse().manifest.bundleDigest);
    expect(stored.spec).toEqual(json<AgentSpec>(COMPOSITION_CONTRACT_DIR, "valid/two-skill.agent-spec.json"));
    expect((db.prepare("SELECT bundle_digest FROM agent_specs").get() as { bundle_digest: string }).bundle_digest).toBe(fixtureResponse().manifest.bundleDigest);
  });

  it.each(["unauthenticated", "not_found", "payload_too_large", "unreachable", "invalid_response"] as const)(
    "writes nothing and never renders locally when Cockpit fails with %s", async (reason) => {
      const warnings: object[] = [];
      const result = await new BundledComposition(db, new FakeSource(new BundleRequestError(reason)), { enabled: true, logger: { warn: (o) => warnings.push(o) } }).compose(input());
      expect(result).toEqual({ ok: false, reason });
      expect(count(db, "agent_specs")).toBe(0);
      expect(count(db, "composition_decisions")).toBe(0);
      expect(warnings).toEqual([{ source: "cockpit", reason, revision: "CR-0002-1" }]);
    },
  );

  it("is not final while a selected skill is excluded: nothing is written", async () => {
    const response = fixtureResponse();
    const skill = response.manifest.included.find((e) => e.kind === "skill" && e.ref === "claude-skills:example-tests")!;
    const files = response.files.filter((f) => f.relPath !== skill.relPath);
    const request = fixtureRequest();
    const bundle = assembleBundle({
      request, rendered: files, compiler: response.manifest.compiler,
      included: response.manifest.included.filter((e) => e !== skill),
      excluded: [...response.manifest.excluded, { kind: "skill", ref: skill.ref, reason: "over the token budget" }],
    });
    const result = await new BundledComposition(db, new FakeSource(bundle), on).compose(input());
    expect(result).toEqual({ ok: false, reason: "not_final", excludedSkills: [{ ref: "claude-skills:example-tests", reason: "over the token budget" }] });
    expect(count(db, "agent_specs")).toBe(0);
  });

  it("requests nothing for a harness bundle v1 cannot render, or a draft that makes an invalid request", async () => {
    const source = new FakeSource(fixtureResponse());
    const cursor = input();
    cursor.spec.harness = "cursor";
    expect(await new BundledComposition(db, source, on).compose(cursor)).toMatchObject({ ok: false, reason: "unsupported_harness" });
    const unsorted = input();
    unsorted.spec.context.fragments = ["typescript-style", "repo:example"];
    expect(await new BundledComposition(db, source, on).compose(unsorted)).toMatchObject({ ok: false, reason: "invalid_request" });
    const overBudget = input();
    overBudget.tokenBudget = 0;
    expect(await new BundledComposition(db, source, on).compose(overBudget)).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(source.requests).toEqual([]);
    expect(count(db, "agent_specs")).toBe(0);
  });

  it("refuses a reused revision or decision id, or a missing task, without asking Cockpit", async () => {
    await new BundledComposition(db, new FakeSource(fixtureResponse()), on).compose(input());
    const source = new FakeSource(fixtureResponse());
    expect(await new BundledComposition(db, source, on).compose(input())).toMatchObject({ ok: false, reason: "composition_rejected", detail: expect.stringMatching(/already exists/) });
    const reusedDecision = input();
    reusedDecision.spec.composition_revision_id = "CR-0002-2";
    reusedDecision.decision.composition_revision_id = "CR-0002-2";
    expect(await new BundledComposition(db, source, on).compose(reusedDecision)).toMatchObject({ ok: false, reason: "composition_rejected", detail: expect.stringMatching(/already explains/) });
    const noTask = input();
    noTask.spec.composition_revision_id = "CR-0002-3";
    noTask.spec.task_id = "AG-9999";
    expect(await new BundledComposition(db, source, on).compose(noTask)).toMatchObject({ ok: false, reason: "composition_rejected", detail: expect.stringMatching(/does not exist/) });
    expect(source.requests).toEqual([]);
    expect(count(db, "agent_specs")).toBe(1);
  });

  it("reports a revision the store refuses, and writes nothing", async () => {
    const draft = input();
    (draft.spec.intent as { complexity: string }).complexity = "XL";  // schema-invalid spec: only the store's full validation catches it
    const result = await new BundledComposition(db, new FakeSource(fixtureResponse()), on).compose(draft);
    expect(result).toMatchObject({ ok: false, reason: "composition_rejected" });
    expect(count(db, "agent_specs")).toBe(0);
  });

  it("keeps the token out of the database, its WAL and every returned or logged value", async () => {
    const server = await cockpit((_req, _body, res) => send(res, 200, fixtureResponse()));
    const warnings: object[] = [];
    try {
      const composition = new BundledComposition(db, new CockpitBundleClient(server.url, tokenPath), { enabled: true, logger: { warn: (o) => warnings.push(o) } });
      const ok = await composition.compose(input());
      expect(ok.ok).toBe(true);
      const denied = await new BundledComposition(db, new CockpitBundleClient(server.url, join(dir, "absent")), { enabled: true, logger: { warn: (o) => warnings.push(o) } }).compose(input());
      expect(JSON.stringify([ok, denied, warnings])).not.toContain(TOKEN);
    } finally { await server.close(); }
    for (const file of readdirSync(dir).filter((f) => f.startsWith("t.db"))) {
      expect(readFileSync(join(dir, file)).includes(Buffer.from(TOKEN)), file).toBe(false);
    }
  });

  it("derives the request in the spec's own order and pins", () => {
    const request = bundleRequestFor(input());
    expect(request).toEqual(fixtureRequest());
  });
});
