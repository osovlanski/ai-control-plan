import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson, computeAssetDigest, computeSnapshotDigest, isCompatibleVersion, MAX_ASSET_CONTENT_BYTES, REGISTRY_CONTRACT_DIR,
  validateContent, validateError, validateSnapshot, type RegistrySnapshot,
} from "../src/registry-contract.js";

const fixture = (path: string): unknown => JSON.parse(readFileSync(join(REGISTRY_CONTRACT_DIR, "fixtures", path), "utf8"));

describe("registry contract v1 conformance fixtures", () => {
  it("accepts every valid fixture", () => {
    expect(validateSnapshot(fixture("valid/snapshot.json"))).toMatchObject({ ok: true });
    expect(validateContent(fixture("valid/content-skill.json"))).toMatchObject({ ok: true });
    expect(validateContent(fixture("valid/content-mcp.json"))).toMatchObject({ ok: true });
    expect(validateError(fixture("valid/error.json"))).toBe(true);
  });

  const expectations: Record<string, RegExp> = {
    "missing-digest.json": /must have required property 'digest'/,
    "mcp-secret-value.json": /\/mcp\/env\/EXAMPLE_TOKEN must be object/,
    "mcp-inline-secret-arg.json": /\/mcp\/args\/1 must NOT be valid/,
    "mcp-quoted-secret-arg.json": /\/mcp\/args\/1 must NOT be valid/,
    "unordered-assets.json": /is not strictly after/,
    "stale-snapshot-digest.json": /snapshotDigest .* does not match/,
    "unknown-major.json": /unsupported schemaVersion "2.0"/,
  };

  it("has an expectation for every invalid fixture", () => {
    expect(readdirSync(join(REGISTRY_CONTRACT_DIR, "fixtures/invalid")).sort()).toEqual(Object.keys(expectations).sort());
  });

  for (const [file, reason] of Object.entries(expectations)) {
    it(`rejects invalid/${file} for the stated reason`, () => {
      const result = validateSnapshot(fixture(`invalid/${file}`));
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.errors.join("\n")).toMatch(reason);
    });
  }
});

describe("registry contract v1 digests", () => {
  it("excludes only the volatile fields from snapshotDigest", () => {
    const snapshot = fixture("valid/snapshot.json") as RegistrySnapshot;
    const touched = structuredClone(snapshot.assets);
    touched[0]!.installedAt = "2030-01-01T00:00:00.000Z";
    touched[0]!.lastUsedAt = "2030-01-01T00:00:00.000Z";
    touched[0]!.stats = { invocations: 3 };
    expect(computeSnapshotDigest(touched)).toBe(snapshot.snapshotDigest);
    touched[0]!.enabled = false;
    expect(computeSnapshotDigest(touched)).not.toBe(snapshot.snapshotDigest);
  });

  it("orders content by path bytes, independent of input order", () => {
    const a = { path: "b.md", bytes: Buffer.from("b") };
    const b = { path: "a/z.md", bytes: Buffer.from("z") };
    expect(computeAssetDigest([a, b])).toBe(computeAssetDigest([b, a]));
    expect(computeAssetDigest([a])).not.toBe(computeAssetDigest([{ ...a, path: "c.md" }]));
  });

  it("canonicalises key order and rejects non-integer numbers", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
  });

  it("rejects a content body whose bytes do not match its digest", () => {
    const content = structuredClone(fixture("valid/content-skill.json")) as { files: Array<{ content: string }> };
    content.files[0]!.content += "x";
    const result = validateContent(content);
    expect(result.ok).toBe(false);
  });
});

describe("registry contract v1 secret and size guards", () => {
  const withArg = (arg: string): RegistrySnapshot => {
    const snapshot = structuredClone(fixture("valid/snapshot.json")) as RegistrySnapshot;
    const mcpAsset = snapshot.assets.find((a) => a.mcp)!;
    mcpAsset.mcp!.args = ["--stdio", arg];
    snapshot.snapshotDigest = computeSnapshotDigest(snapshot.assets);
    return snapshot;
  };

  it("rejects quoted and spaced credential assignments with a correct digest", () => {
    for (const arg of ['token="FAKE_REVIEW_VALUE"', "password='FAKE_REVIEW_VALUE'", 'api_key = "FAKE_REVIEW_VALUE"', "SECRET=FAKE_REVIEW_VALUE"]) {
      const result = validateSnapshot(withArg(arg));
      expect(result.ok, arg).toBe(false);
      expect(result.ok ? "" : result.errors.join("\n"), arg).toMatch(/\/mcp\/args\/1 must NOT be valid/);
    }
  });

  it("still accepts placeholders and the redaction marker, quoted or not", () => {
    for (const arg of ['token="***"', "token=${API_TOKEN}", "token='${API_TOKEN}'", "--stdio"]) {
      expect(validateSnapshot(withArg(arg)), arg).toMatchObject({ ok: true });
    }
  });

  it("classifies non-integer digested metadata as a validation failure instead of throwing", () => {
    const snapshot = structuredClone(fixture("valid/snapshot.json")) as RegistrySnapshot & { assets: Array<Record<string, unknown>> };
    snapshot.assets[0]!.futureField = 1.5;
    const result = validateSnapshot(snapshot);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors.join("\n")).toMatch(/outside the digested value space/);
  });

  const contentOf = (files: Array<{ path: string; bytes: Buffer; encoding?: "utf8" | "base64" }>) => ({
    schemaVersion: "1.0", id: "skill:claude-code:big", kind: "skill" as const,
    digest: computeAssetDigest(files),
    files: files.map((f) => ({
      path: f.path, size: f.bytes.length, digest: `sha256:${createHash("sha256").update(f.bytes).digest("hex")}`,
      encoding: f.encoding ?? "utf8", content: f.bytes.toString(f.encoding ?? "utf8"),
    })),
  });

  it("enforces the 4 MiB decoded-content limit across files and encodings", () => {
    const atLimit = contentOf([{ path: "SKILL.md", bytes: Buffer.alloc(MAX_ASSET_CONTENT_BYTES, "a") }]);
    expect(validateContent(atLimit)).toMatchObject({ ok: true });
    const overOne = contentOf([{ path: "SKILL.md", bytes: Buffer.alloc(MAX_ASSET_CONTENT_BYTES + 1, "a") }]);
    expect(validateContent(overOne)).toMatchObject({ ok: false, errors: [expect.stringMatching(/^payload_too_large/)] });
    const half = MAX_ASSET_CONTENT_BYTES / 2;
    const overSplit = contentOf([
      { path: "SKILL.md", bytes: Buffer.alloc(half, "a") },
      { path: "data.bin", bytes: Buffer.alloc(half + 1, 7), encoding: "base64" },
    ]);
    expect(validateContent(overSplit)).toMatchObject({ ok: false, errors: [expect.stringMatching(/^payload_too_large/)] });
  });
});

describe("registry contract v1 version policy", () => {
  it("requires the same major and a server minor at least the client's", () => {
    expect(isCompatibleVersion("1.0", "1.0")).toBe(true);
    expect(isCompatibleVersion("1.3", "1.0")).toBe(true);
    expect(isCompatibleVersion("1.0", "1.1")).toBe(false);
    expect(isCompatibleVersion("2.0", "1.0")).toBe(false);
    expect(isCompatibleVersion(undefined, "1.0")).toBe(false);
  });

  it("accepts an additive field from a newer minor", () => {
    const snapshot = structuredClone(fixture("valid/snapshot.json")) as RegistrySnapshot & Record<string, unknown>;
    snapshot.schemaVersion = "1.4";
    snapshot.assets[0]!.futureField = "x";
    snapshot.snapshotDigest = computeSnapshotDigest(snapshot.assets);
    expect(validateSnapshot(snapshot)).toMatchObject({ ok: true });
  });
});
