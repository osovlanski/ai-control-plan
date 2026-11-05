/**
 * O6 S1 (docs/agentic-os-o6-memory-writeback.md §3, §5 row S1): the memory v1 contract, the
 * `memory.read` capability and API 2.8. Contract and types only; no route serves either shape yet.
 * Every secret here is FAKE-*-not-real.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_OPTIONAL_CAPABILITIES, COMMAND_CAPABILITIES, CONTROL_PLANE_API_VERSION, INGEST_CAPABILITIES, OBSERVABILITY_CAPABILITIES } from "@agent-plane/core";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { buildServer } from "../src/server.js";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { computeAssetDigest } from "../src/registry-contract.js";
import {
  computeMemoryBundleDigest,
  computeMemoryProposalId,
  computeMemorySnapshotDigest,
  MEMORY_CONTRACT_DIR,
  validateMemoryBundleSnapshot,
  validateMemoryProposalEvent,
  validateMemoryProposalPage,
  type MemoryBundleSnapshot,
  type MemoryProposalEvent,
} from "../src/memory-contract.js";

const fixture = <T>(kind: "valid" | "invalid", name: string) => JSON.parse(readFileSync(join(MEMORY_CONTRACT_DIR, "fixtures", kind, name), "utf8")) as T;
const validate = (name: string, body: unknown) =>
  name.startsWith("snapshot") ? validateMemoryBundleSnapshot(body) : name.startsWith("page") ? validateMemoryProposalPage(body) : validateMemoryProposalEvent(body);
const errorsOf = (name: string) => {
  const r = validate(name, fixture("invalid", name));
  return r.ok ? [] : r.errors.join("\n");
};
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("memory v1 contract", () => {
  it("its fixtures pass and fail the reference validators as named", () => {
    for (const kind of ["valid", "invalid"] as const) {
      const names = readdirSync(join(MEMORY_CONTRACT_DIR, "fixtures", kind));
      for (const prefix of ["snapshot-", "event-", "page-"]) expect(names.some((n) => n.startsWith(prefix))).toBe(true);
      for (const name of names) expect([name, validate(name, fixture(kind, name)).ok]).toEqual([name, kind === "valid"]);
    }
  });

  it("each invalid snapshot fails for the rule it names", () => {
    expect(errorsOf("snapshot-unsorted-members.json")).toMatch(/members are not strictly sorted/);
    expect(errorsOf("snapshot-dotdot-path.json")).toMatch(/\/members\/1\/path/);
    expect(errorsOf("snapshot-absolute-path.json")).toMatch(/\/members\/0\/path/);
    expect(errorsOf("snapshot-not-markdown.json")).toMatch(/\/members\/0\/path/);
    expect(errorsOf("snapshot-unknown-field.json")).toMatch(/additional/);
    expect(errorsOf("snapshot-unknown-top-field.json")).toMatch(/additional/);
    expect(errorsOf("snapshot-bundle-digest-mismatch.json")).toMatch(/digest .* does not match its members/);
    expect(errorsOf("snapshot-digest-stale.json")).toMatch(/snapshotDigest .* does not match/);
    expect(errorsOf("snapshot-stale-exceeds-members.json")).toMatch(/staleMembers exceeds members/);
    expect(errorsOf("snapshot-health-member-count.json")).toMatch(/health\/members is not the number of members/);
    expect(errorsOf("snapshot-unsorted-bundles.json")).toMatch(/bundles are not strictly sorted/);
    expect(errorsOf("snapshot-scoped-without-repos.json")).toMatch(/repoScopes are empty exactly when/);
    expect(errorsOf("snapshot-empty-with-age.json")).toMatch(/oldestAgeDays is null exactly when/);
    expect(errorsOf("snapshot-newer-minor.json")).toMatch(/unsupported schemaVersion "1.1"/);
  });

  it("each invalid proposal fails for the rule it names", () => {
    expect(errorsOf("event-inline-secret.json")).toMatch(/\/body contains an inline credential/);
    expect(errorsOf("event-absolute-path.json")).toMatch(/\/body contains an absolute path/);
    expect(errorsOf("event-hostname.json")).toMatch(/\/description contains a hostname or address/);
    expect(errorsOf("event-body-over-4kb.json")).toMatch(/body exceeds 4096 UTF-8 bytes/);
    expect(errorsOf("event-supersedes-without-target.json")).toMatch(/empty when target is null/);
    expect(errorsOf("event-bad-name.json")).toMatch(/\/name/);
    expect(errorsOf("event-multiline-description.json")).toMatch(/\/description/);
    expect(errorsOf("event-unknown-field.json")).toMatch(/additional/);
    expect(errorsOf("event-failed-outcome.json")).toMatch(/\/evidence\/outcome/);
    expect(errorsOf("event-bad-proposal-id.json")).toMatch(/\/proposalId/);
    expect(errorsOf("event-newer-minor.json")).toMatch(/unsupported schemaVersion/);
    expect(errorsOf("page-out-of-order.json")).toMatch(/seq is not after/);
    expect(errorsOf("page-next-behind.json")).toMatch(/next is the last event's seq/);
  });

  it("a body of exactly 4096 UTF-8 bytes is allowed; a page over 100 proposals is not", () => {
    const one = fixture<MemoryProposalEvent>("valid", "event-untargeted.json");
    expect(validateMemoryProposalEvent({ ...one, body: "é".repeat(2048) }).ok).toBe(true);
    const events = Array.from({ length: 101 }, (_, i) => ({ ...one, proposalId: `mp1_${i.toString(16).padStart(64, "0")}`, seq: i + 1 }));
    expect(validateMemoryProposalPage({ schemaVersion: "1.0", events, next: 101 }).ok).toBe(false);
    expect(validateMemoryProposalPage({ schemaVersion: "1.0", events: events.slice(0, 100), next: 100 }).ok).toBe(true);
  });

  it("the bundle digest is the registry v1 asset digest over the same files, and it is order-free", () => {
    const files = [
      { path: "b.md", bytes: Buffer.from("---\nname: b\n---\nfact b\n") },
      { path: "MEMORY.md", bytes: Buffer.from("- [b](b.md)\n") },
      { path: "a.md", bytes: Buffer.from("fact a, é\n") },
    ];
    const members = files.map((f) => ({ path: f.path, digest: `sha256:${createHash("sha256").update(f.bytes).digest("hex")}` }));
    expect(computeMemoryBundleDigest(members)).toBe(computeAssetDigest(files));
    expect(computeMemoryBundleDigest([...members].reverse())).toBe(computeMemoryBundleDigest(members));
    // The empty bundle digests the empty line set.
    expect(computeMemoryBundleDigest([])).toBe(`sha256:${hex("")}`);
  });

  it("the snapshot digest covers health and not observedAt", () => {
    const snap = fixture<MemoryBundleSnapshot>("valid", "snapshot-two-bundles.json");
    expect(validateMemoryBundleSnapshot({ ...snap, observedAt: "2027-01-01T00:00:00.000Z" }).ok).toBe(true);
    const healthier = structuredClone(snap);
    healthier.bundles[1]!.health.staleMembers = 0;
    expect(computeMemorySnapshotDigest(healthier.bundles)).not.toBe(snap.snapshotDigest);
  });

  it("proposalId is stable for a session, index and body, and moves with any of them", () => {
    const id = computeMemoryProposalId("run_01", 0, "body\n");
    expect(id).toMatch(/^mp1_[0-9a-f]{64}$/);
    expect(computeMemoryProposalId("run_01", 0, "body\n")).toBe(id);
    expect(new Set([id, computeMemoryProposalId("run_02", 0, "body\n"), computeMemoryProposalId("run_01", 1, "body\n"), computeMemoryProposalId("run_01", 0, "body.\n")]).size).toBe(4);
    expect(fixture<MemoryProposalEvent>("valid", "event-targeted.json").proposalId).toBe(computeMemoryProposalId("run_01", 0, fixture<MemoryProposalEvent>("valid", "event-targeted.json").body));
  });

  it("no valid fixture carries a hostname, an absolute path or a FAKE value", () => {
    for (const name of readdirSync(join(MEMORY_CONTRACT_DIR, "fixtures", "valid"))) {
      const raw = readFileSync(join(MEMORY_CONTRACT_DIR, "fixtures", "valid", name), "utf8");
      expect([name, /FAKE-|\/home\/|\/Users\/|localhost|127\.0\.0\.1/.test(raw)]).toEqual([name, false]);
    }
  });
});

describe("memory.read and API 2.8", () => {
  it("is an observability capability the browser may go without, and not a command or ingest one", () => {
    expect(CONTROL_PLANE_API_VERSION).toBe("2.8");
    expect(OBSERVABILITY_CAPABILITIES).toContain("memory.read");
    expect(BROWSER_OPTIONAL_CAPABILITIES).toEqual(["telemetry.read", "memory.read"]);
    expect([...COMMAND_CAPABILITIES, ...INGEST_CAPABILITIES]).not.toContain("memory.read");
  });

  it("is listed in /api/meta and held by a freshly minted credential", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-plane-memory-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    const db = openDb(config.dbPath);
    const built = buildServer({ config, db });
    try {
      const secret = readCredential(credentialPath(config.dir)).secrets[0]!;
      expect(secret.capabilities).toContain("memory.read");
      const res = await built.app.inject({ method: "GET", url: "/api/meta", headers: { authorization: `Bearer ${secret.secret}` } });
      expect(res.statusCode).toBe(200);
      const meta = res.json() as { apiVersion: string; capabilities: string[] };
      expect(meta.apiVersion).toBe("2.8");
      expect(meta.capabilities).toContain("memory.read");
    } finally {
      await built.app.close();
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
