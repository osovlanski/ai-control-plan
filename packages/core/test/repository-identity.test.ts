import { describe, expect, it } from "vitest";
import { normalizeRemoteIdentity } from "../src/repository-identity.js";

describe("repository remote identity", () => {
  it("correlates HTTPS, SSH, and scp-like forms without retaining credentials", () => {
    const inputs = [
      "https://token:secret@GitHub.com/Org/Repo.git?access_token=leak#fragment",
      "ssh://deploy-user@github.com:22/Org/Repo.git",
      "git@github.com:Org/Repo.git",
    ];
    const normalized = inputs.map(normalizeRemoteIdentity);
    expect(normalized.every((item) => item.kind === "normalized")).toBe(true);
    expect(new Set(normalized.map((item) => item.kind === "normalized" && item.fingerprint)).size).toBe(1);
    expect(JSON.stringify(normalized)).not.toMatch(/token|secret|access_token|deploy-user|git@/);
  });

  it("lowercases only the host and preserves repository path case", () => {
    expect(normalizeRemoteIdentity("https://EXAMPLE.com/Org/Repo.git")).toMatchObject({
      kind: "normalized",
      value: "example.com/Org/Repo",
    });
    expect(normalizeRemoteIdentity("https://example.com/org/repo.git")).not.toEqual(
      normalizeRemoteIdentity("https://example.com/Org/Repo.git"),
    );
  });

  it.each(["http://host/repo", "git://host/repo", "file:///tmp/repo", "../repo", "C:/repo", "not a remote"])(
    "returns an opaque unsupported result for %s",
    (remote) => expect(normalizeRemoteIdentity(remote)).toEqual({ kind: "unsupported" }),
  );
});
