/**
 * M2 S6 test rig: a loopback stand-in for Cockpit's registry and bundle routes (the same contract
 * `composer-start.test.ts` drives), a git repository, and a plane booted with the composer on.
 * Every secret here is FAKE-*-not-real.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteCredential, credentialPath, readCredential } from "../../src/auth/credential-file.js";
import { assembleBundle, fileDigest, type BundleRequest } from "../../src/bundle-contract.js";
import { loadConfig, type ResolvedConfig } from "../../src/config.js";
import { openDb, type Db } from "../../src/db/index.js";
import { computeSnapshotDigest, REGISTRY_VERSION_HEADER, type RegistryAsset } from "../../src/registry-contract.js";
import { buildServer, type BuiltServer } from "../../src/server.js";

export const COCKPIT_TOKEN = "FAKE-cockpit-registry-token-not-real-s6";
export const TS_REVIEW = "claude-skills:ts-review";
const SKILL_BODY = "---\nname: ts-review\n---\nReview TypeScript.\n";

interface FakeCockpit { url: string; renders: number; close(): Promise<void> }

async function fakeCockpit(): Promise<FakeCockpit> {
  const asset: RegistryAsset = {
    id: TS_REVIEW, digest: fileDigest(SKILL_BODY), kind: "skill", nativeKind: "claude-skills", name: "ts-review", description: "a skill",
    tags: ["coding", "typescript"], targets: ["claude"], compatibility: { assistants: ["claude", "codex"] },
    requirements: { secretRefs: [] }, conflicts: [], lineage: { origin: "library" }, enabled: true, installedAt: "2026-10-01T09:00:00.000Z",
  };
  const state: FakeCockpit = { url: "", renders: 0, close: async () => {} };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${COCKPIT_TOKEN}`) return send(401, { error: { code: "unauthenticated", message: "no" } });
      if (req.method === "GET" && req.url === "/api/v1/registry/assets") {
        return send(200, { schemaVersion: "1.0", snapshotDigest: computeSnapshotDigest([asset]), assets: [asset] }, { [REGISTRY_VERSION_HEADER]: "1.0" });
      }
      if (req.method === "POST" && req.url === "/api/v1/registry/bundle") {
        state.renders++;
        const request = JSON.parse(body) as BundleRequest;
        const rendered = [{ relPath: request.harness === "codex" ? "AGENTS.md" : "CLAUDE.md", content: "Use strict TypeScript." }];
        const included: Parameters<typeof assembleBundle>[0]["included"] = request.fragments.map((ref) => ({ kind: "fragment", ref, digest: fileDigest("Use strict TypeScript."), reason: "requested by the composition" }));
        for (const pin of request.skills) {
          const relPath = `.claude/skills/${pin.id.split(":")[1]}/SKILL.md`;
          rendered.push({ relPath, content: SKILL_BODY });
          included.push({ kind: "skill", ref: pin.id, digest: pin.digest, relPath, reason: "selected by the composition" });
        }
        return send(200, assembleBundle({ request, rendered, compiler: { name: "fake-cockpit", version: "1.0.0" }, included, excluded: [] }));
      }
      return send(404, { error: { code: "not_found", message: "no route" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return state;
}

export interface Rig {
  root: string;
  repo: string;
  db: Db;
  config: ResolvedConfig;
  built: BuiltServer;
  cockpit: FakeCockpit;
  auth(): { authorization: string };
  /** A credential holding only `usage.write`, as Cockpit's M11 import would. */
  usageAuth(): { authorization: string };
  /** POSTs one usage v1 record (FAKE values) bound to a run. */
  postUsage(record: { eventId: string; runId: string; accounting: "delta" | "cumulative"; tokensIn: number; tokensOut: number; costUsd?: number | null; apiEquivalentUsd?: number }): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

export interface RigOptions {
  assistants?: ResolvedConfig["assistants"];
  budget?: ResolvedConfig["composer"]["policy"]["budget"];
  requireRevision?: boolean;
  enabled?: boolean;
  now?: () => Date;
  configure?: (config: ResolvedConfig) => void;
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

export async function bootRig(options: RigOptions = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "composer-s6-"));
  const home = join(root, "home");
  const plane = join(root, "plane");
  const repo = join(root, "repo");
  mkdirSync(join(home, ".cockpit"), { recursive: true });
  mkdirSync(plane);
  mkdirSync(repo);
  writeFileSync(join(home, ".cockpit", "registry-token"), `${COCKPIT_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", devDependencies: { typescript: "^5.9.0" } }));
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  const cockpit = await fakeCockpit();
  const config = loadConfig({ AGENT_PLANE_HOME: plane });
  config.assistants = options.assistants ?? { "fake-claude": { provider: "fake" } };
  config.repoAllowlist = [repo];
  config.policy.approvalMode = "auto-approve";
  config.execution.harnessModes.single = true;
  config.scheduler = { ...config.scheduler!, enabled: true };
  config.registry.cockpit = { enabled: true, baseUrl: cockpit.url, tokenPath: join(home, ".cockpit", "registry-token"), maxCacheAgeHours: 48 };
  config.composer.enabled = options.enabled ?? true;
  config.composer.requireRevision = options.requireRevision ?? false;
  config.composer.assets.allowlist = [{ id: TS_REVIEW, digest: fileDigest(SKILL_BODY) }];
  config.composer.context.fragments.default = ["typescript-style"];
  config.composer.policy.permitAmbient = true;
  config.composer.policy.budget = options.budget ?? {};
  options.configure?.(config);
  const db = openDb(config.dbPath);
  const built = buildServer({ config, db, composerHostname: "fake-host-s6.example", ...(options.now ? { now: options.now } : {}) });
  built.registry.init();
  await built.registry.syncAll();
  await built.app.ready();
  let usageHeaders: { authorization: string } | undefined;
  const usageAuth = () => {
    if (usageHeaders) return usageHeaders;
    const path = credentialPath(config.dir);
    const file = readCredential(path);
    const next = { kid: `k_${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities: ["usage.write"], createdAt: new Date().toISOString(), notAfter: null };
    file.secrets.push(next);
    atomicWriteCredential(path, file);
    usageHeaders = { authorization: `Bearer ${next.secret}` };
    return usageHeaders;
  };
  return {
    root, repo, db, config, built, cockpit, usageAuth,
    auth: () => ({ authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` }),
    postUsage: async (r) => {
      const payload = {
        schemaVersion: "1.0", eventId: r.eventId, runId: r.runId, provider: "fake", sessionRef: `FAKE-session-${r.runId}`, source: "FAKE-import",
        assistantId: "fake-claude", model: "fake-1", accounting: r.accounting, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cachedTokens: 0,
        costUsd: r.costUsd ?? null, apiEquivalentUsd: r.apiEquivalentUsd ?? 0, pricingVersion: "FAKE-pricing-not-real", observedAt: "2030-01-01T00:05:00.000Z",
      };
      const res = await built.app.inject({ method: "POST", url: "/api/usage/records", headers: usageAuth(), payload });
      return { status: res.statusCode, body: res.json() as unknown };
    },
    close: async () => {
      await built.app.close();
      if (db.open) db.close();
      await cockpit.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Resolves when the task reaches one of the given states. */
export function reaches(built: BuiltServer, id: string, states: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    const current = built.tasks.get(id)?.state;
    if (current && states.includes(current)) return resolve(current);
    const off = built.bus.subscribe(id, (p) => {
      if (p.kind === "state" && states.includes(p.state!.state)) {
        off();
        resolve(p.state!.state);
      }
    });
  });
}
