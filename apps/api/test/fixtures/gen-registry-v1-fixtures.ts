/**
 * Regenerates contracts/registry/v1/fixtures. Every value is fake. Run with
 * `pnpm --filter @agent-plane/api exec tsx test/fixtures/gen-registry-v1-fixtures.ts`
 * after a contract change, then review the diff: the fixtures are the
 * conformance suite both repositories run, so a change here is a contract change.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson, computeAssetDigest, computeSnapshotDigest, REGISTRY_CONTRACT_DIR, type RegistryAsset,
} from "../../src/registry-contract.js";

const fixtures = join(REGISTRY_CONTRACT_DIR, "fixtures");
mkdirSync(join(fixtures, "valid"), { recursive: true });
mkdirSync(join(fixtures, "invalid"), { recursive: true });
const FAKE_SECRET = ["fake", "secret", "value", "not", "real"].join("-");

const skillFiles = [
  { path: "SKILL.md", bytes: Buffer.from("---\nname: example-skill\ndescription: Example skill used by the registry v1 conformance fixtures.\n---\n\n# Example skill\n") },
  { path: "references/notes.md", bytes: Buffer.from("Reference notes.\n") },
];
const agentBytes = Buffer.from("---\ndescription: Example agent.\n---\nYou review diffs.\n");
const mcp = {
  transport: "stdio" as const,
  command: "example-mcp",
  args: ["--stdio", "--token=${EXAMPLE_TOKEN}"],
  env: { EXAMPLE_TOKEN: { type: "env" as const, name: "EXAMPLE_TOKEN" } },
};
const mcpBytes = Buffer.from(canonicalJson(mcp));
const base = { requirements: { secretRefs: [] }, conflicts: [], enabled: true, installedAt: "2026-10-01T09:00:00.000Z" };

const assets: RegistryAsset[] = [
  {
    ...base, id: "claude-agents:example-agent.md", digest: computeAssetDigest([{ path: "example-agent.md", bytes: agentBytes }]),
    kind: "agent", nativeKind: "claude-agents", name: "example-agent.md", description: "Example agent.",
    tags: ["review"], targets: ["claude"], compatibility: { assistants: ["claude"] }, lineage: { origin: "manual" },
  },
  {
    ...base, id: "claude-skills:example-skill", digest: computeAssetDigest(skillFiles),
    kind: "skill", nativeKind: "claude-skills", name: "example-skill",
    description: "Example skill used by the registry v1 conformance fixtures.",
    tags: ["development", "docs"], targets: ["claude", "codex"], compatibility: { assistants: ["claude", "codex", "cursor"] },
    lineage: { origin: "proposal", sourceUrl: "https://example.invalid/example/example-skill" },
    lastUsedAt: "2026-10-04T12:00:00.000Z",
  },
  {
    ...base, id: "mcp:example-mcp", digest: computeAssetDigest([{ path: "server.json", bytes: mcpBytes }]),
    kind: "mcp_server", nativeKind: "mcp", name: "example-mcp", description: "",
    tags: [], targets: ["claude"], compatibility: { assistants: ["claude", "codex"] },
    requirements: { secretRefs: [{ type: "env", name: "EXAMPLE_TOKEN" }] }, lineage: { origin: "unknown" }, mcp,
  },
];
const snapshot = { schemaVersion: "1.0", snapshotDigest: computeSnapshotDigest(assets), assets };

const write = (path: string, value: unknown) => writeFileSync(join(fixtures, path), `${JSON.stringify(value, null, 2)}\n`);
const file = (path: string, bytes: Buffer) => ({
  path, size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, encoding: "utf8", content: bytes.toString("utf8"),
});
const clone = (): typeof snapshot => JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;

write("valid/snapshot.json", snapshot);
write("valid/content-skill.json", { schemaVersion: "1.0", id: assets[1]!.id, kind: "skill", digest: assets[1]!.digest, files: skillFiles.map((f) => file(f.path, f.bytes)) });
write("valid/content-mcp.json", { schemaVersion: "1.0", id: assets[2]!.id, kind: "mcp_server", digest: assets[2]!.digest, mcp, files: [file("server.json", mcpBytes)] });
write("valid/error.json", { error: { code: "unauthenticated", message: "bearer token required" } });

const missingDigest = clone();
delete (missingDigest.assets[1] as Partial<RegistryAsset>).digest;
write("invalid/missing-digest.json", missingDigest);

const secretEnv = clone();
(secretEnv.assets[2]!.mcp!.env as Record<string, unknown>).EXAMPLE_TOKEN = FAKE_SECRET;
write("invalid/mcp-secret-value.json", secretEnv);

const secretArg = clone();
secretArg.assets[2]!.mcp!.args = ["--stdio", `--api_key=${FAKE_SECRET}`];
write("invalid/mcp-inline-secret-arg.json", secretArg);

const quotedSecretArg = clone();
quotedSecretArg.assets[2]!.mcp!.args = ["--stdio", `token="${FAKE_SECRET}"`];
quotedSecretArg.snapshotDigest = computeSnapshotDigest(quotedSecretArg.assets);
write("invalid/mcp-quoted-secret-arg.json", quotedSecretArg);

const unordered = clone();
unordered.assets = [unordered.assets[1]!, unordered.assets[0]!, unordered.assets[2]!];
unordered.snapshotDigest = computeSnapshotDigest(unordered.assets);
write("invalid/unordered-assets.json", unordered);

const staleDigest = clone();
staleDigest.assets[0]!.description = "edited after the digest was computed";
write("invalid/stale-snapshot-digest.json", staleDigest);

const unknownMajor = clone();
unknownMajor.schemaVersion = "2.0";
write("invalid/unknown-major.json", unknownMajor);
