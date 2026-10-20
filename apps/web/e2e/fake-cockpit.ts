/**
 * A loopback stand-in for Cockpit's registry and bundle routes (registry v1, bundle v1), so a
 * browser walkthrough can compose against a real Control Plane without Cockpit. Test-only: the token
 * is a FAKE value and nothing here touches an assistant's real configuration.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { assembleBundle, fileDigest, type BundleRequest } from "../../api/src/bundle-contract.js";
import { computeSnapshotDigest, REGISTRY_VERSION_HEADER, type RegistryAsset } from "../../api/src/registry-contract.js";

export const FAKE_COCKPIT_TOKEN = "FAKE-cockpit-registry-token-not-real-m7";

export interface FakeCockpit {
  url: string;
  /** Skill id (`claude-skills:name`) to its body and the facts stage 3 reads. */
  skills: Map<string, { body: string; tags: string[]; assistants: string[] }>;
  fragments: Map<string, string>;
  requests: Array<{ method?: string; url?: string }>;
  close(): Promise<void>;
}

const assetsOf = (c: FakeCockpit): RegistryAsset[] =>
  [...c.skills].map(([id, s]): RegistryAsset => ({
    id, digest: fileDigest(s.body), kind: "skill", nativeKind: "claude-skills", name: id.split(":")[1]!, description: "a skill",
    tags: [...s.tags].sort(), targets: ["claude"], compatibility: { assistants: [...s.assistants].sort() },
    requirements: { secretRefs: [] }, conflicts: [], lineage: { origin: "library" }, enabled: true,
    installedAt: "2026-10-01T09:00:00.000Z",
  })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function render(c: FakeCockpit, request: BundleRequest): { status: number; body: unknown } {
  for (const pin of request.skills) {
    const skill = c.skills.get(pin.id);
    if (!skill || fileDigest(skill.body) !== pin.digest) return { status: 404, body: { error: { code: "not_found", message: "skill not installed at that digest" } } };
  }
  for (const name of request.fragments) if (!c.fragments.has(name)) return { status: 404, body: { error: { code: "not_found", message: "unknown fragment" } } };
  const included: Parameters<typeof assembleBundle>[0]["included"] = [];
  const sections: string[] = [];
  for (const name of request.fragments) {
    sections.push(c.fragments.get(name)!);
    included.push({ kind: "fragment", ref: name, digest: fileDigest(c.fragments.get(name)!), reason: "requested by the composition" });
  }
  const rendered = [{ relPath: "CLAUDE.md", content: sections.join("\n\n") || "# Project context" }];
  for (const pin of request.skills) {
    const relPath = `.claude/skills/${pin.id.split(":")[1]}/SKILL.md`;
    rendered.push({ relPath, content: c.skills.get(pin.id)!.body });
    included.push({ kind: "skill", ref: pin.id, digest: pin.digest, relPath, reason: "selected by the composition" });
  }
  return { status: 200, body: assembleBundle({ request, rendered, compiler: { name: "fake-cockpit", version: "1.0.0" }, included, excluded: [] }) };
}

export async function fakeCockpit(): Promise<FakeCockpit> {
  const state: FakeCockpit = { url: "", skills: new Map(), fragments: new Map(), requests: [], close: async () => {} };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      state.requests.push({ method: req.method, url: req.url });
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${FAKE_COCKPIT_TOKEN}`) return send(401, { error: { code: "unauthenticated", message: "no" } });
      if (req.method === "GET" && req.url === "/api/v1/registry/assets") {
        const assets = assetsOf(state);
        return send(200, { schemaVersion: "1.0", snapshotDigest: computeSnapshotDigest(assets), assets }, { [REGISTRY_VERSION_HEADER]: "1.0" });
      }
      if (req.method === "POST" && req.url === "/api/v1/registry/bundle") {
        const out = render(state, JSON.parse(body) as BundleRequest);
        return send(out.status, out.body);
      }
      return send(404, { error: { code: "not_found", message: "no route" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return state;
}
