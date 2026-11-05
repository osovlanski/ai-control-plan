/**
 * O6 S5 (docs/agentic-os-o6-memory-writeback.md §2.3, §5 row S5): the pure parser of the fenced
 * `agent-plane-memory` block. Every secret here is FAKE-*-not-real.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveMemoryProposals,
  lastMemoryBlock,
  memoryProposalId,
  utf8Length,
  type MemoryProposalDeps,
  type MemoryProposalGuard,
  type MemoryProposalInput,
} from "../src/index.js";

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
// A stand-in for the api's contract guards: enough to show a hit is a drop with its reason.
const guardHits = (e: { name: string; description: string; body: string }): MemoryProposalGuard[] => {
  const text = `${e.name} ${e.description} ${e.body}`;
  const hits: MemoryProposalGuard[] = [];
  if (/FAKE-[A-Z]+-not-real/.test(text)) hits.push("credential");
  if (/\/home\//.test(text)) hits.push("absolute_path");
  if (/\.internal\b/.test(text)) hits.push("hostname");
  return hits;
};
const deps: MemoryProposalDeps = { sha256, guardHits };

const BUNDLE_DIGEST = `sha256:${"a".repeat(64)}`;
const entry = (over: Record<string, unknown> = {}) => ({ kind: "fact", name: "close-rig", description: "Close the rig in afterEach", body: "Close the test rig in afterEach.\n", ...over });
const block = (entries: unknown) => `Done.\n\n\`\`\`agent-plane-memory\n${typeof entries === "string" ? entries : JSON.stringify(entries)}\n\`\`\``;
const input = (over: Partial<MemoryProposalInput> = {}): MemoryProposalInput => ({
  sessionId: "run_01",
  taskId: "task_01",
  compositionRevisionId: "rev_01",
  harness: "claude-code",
  model: "claude-sonnet-5-5",
  outcome: "success",
  ambient: false,
  checkpoint: { id: "cp_01", at: "2026-11-05T09:10:00.000Z", reason: "completion" },
  verificationPassed: true,
  changedFiles: 3,
  pinnedBundles: [{ id: "plane-decisions", digest: BUNDLE_DIGEST }],
  lastMessage: block([entry()]),
  ...over,
});

describe("deriveMemoryProposals", () => {
  it("parses one entry into a memory v1 proposal whose id is the contract's", () => {
    const out = deriveMemoryProposals(input(), deps);
    expect(out).toMatchObject({ status: "proposed", dropped: {}, truncated: 0, untargeted: 0, parserVersion: 1 });
    expect(out.proposals).toHaveLength(1);
    const [p] = out.proposals;
    expect(p).toMatchObject({
      index: 0, sessionId: "run_01", taskId: "task_01", compositionRevisionId: "rev_01", checkpointId: "cp_01", harness: "claude-code",
      model: "claude-sonnet-5-5", kind: "fact", name: "close-rig", target: null, supersedes: [],
      evidence: { outcome: "success", verificationPassed: true, changedFiles: 3 }, at: "2026-11-05T09:10:00.000Z",
    });
    expect(p!.proposalId).toBe(memoryProposalId("run_01", 0, "Close the test rig in afterEach.\n", { sha256 }));
    expect(p!.proposalId).toMatch(/^mp1_[0-9a-f]{64}$/);
    expect(p!.bodyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is byte-equal across clocks and time zones: no clock, the checkpoint's at is the time", () => {
    const a = JSON.stringify(deriveMemoryProposals(input(), deps));
    const tz = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      const b = JSON.stringify(deriveMemoryProposals(input(), deps));
      expect(b).toBe(a);
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
    expect(a).not.toContain(new Date().toISOString().slice(0, 13));
  });

  it("only a success session with a verified profile and its completion checkpoint proposes", () => {
    expect(deriveMemoryProposals(input({ outcome: "error" }), deps)).toMatchObject({ status: "skipped", skipReason: "not_success", proposals: [] });
    expect(deriveMemoryProposals(input({ outcome: "neutral" }), deps)).toMatchObject({ status: "skipped", skipReason: "not_success" });
    expect(deriveMemoryProposals(input({ ambient: true }), deps)).toMatchObject({ status: "skipped", skipReason: "ambient" });
    expect(deriveMemoryProposals(input({ checkpoint: null }), deps)).toMatchObject({ status: "skipped", skipReason: "not_completion" });
    for (const reason of ["handoff", "limit", "cancel", "context"]) {
      expect(deriveMemoryProposals(input({ checkpoint: { id: "cp", at: "2026-11-05T09:10:00.000Z", reason } }), deps)).toMatchObject({ skipReason: "not_completion" });
    }
    expect(deriveMemoryProposals(input({ lastMessage: "Done, no block." }), deps)).toMatchObject({ status: "skipped", skipReason: "no_block" });
    expect(deriveMemoryProposals(input({ lastMessage: null }), deps)).toMatchObject({ skipReason: "no_block" });
  });

  it("a malformed block is counted once and proposes nothing", () => {
    for (const text of ["[{ not json", '{"kind":"fact"}', "null"]) {
      expect(deriveMemoryProposals(input({ lastMessage: block(text) }), deps)).toMatchObject({ status: "proposed", proposals: [], dropped: { malformed_block: 1 } });
    }
  });

  it("more than five entries: the first five are read and the rest counted as truncated", () => {
    const entries = Array.from({ length: 7 }, (_, i) => entry({ name: `fact-${i}`, body: `Fact ${i}.` }));
    const out = deriveMemoryProposals(input({ lastMessage: block(entries) }), deps);
    expect(out.proposals.map((p) => p.name)).toEqual(["fact-0", "fact-1", "fact-2", "fact-3", "fact-4"]);
    expect(out.truncated).toBe(2);
  });

  it("drops (never redacts) credentials, absolute paths, hostnames and redacted text, with a counted reason; index stays the block position", () => {
    const out = deriveMemoryProposals(input({
      lastMessage: block([
        entry({ name: "has-secret", body: "token FAKE-TOKEN-not-real works" }),
        entry({ name: "has-path", description: "Lives in /home/operator/repo" }),
        entry({ name: "has-host", body: "Call api.corp.internal first" }),
        entry({ name: "was-redacted", body: "password: [REDACTED]" }),
        entry({ name: "clean-one", body: "A clean fact." }),
      ]),
    }), deps);
    expect(out.dropped).toEqual({ guard_credential: 1, guard_absolute_path: 1, guard_hostname: 1, redacted: 1 });
    expect(out.proposals.map((p) => [p.index, p.name])).toEqual([[4, "clean-one"]]);
    expect(JSON.stringify(out)).not.toMatch(/FAKE-TOKEN|\/home\/|corp\.internal|REDACTED/);
  });

  it("shape checks drop an entry with its reason", () => {
    const out = deriveMemoryProposals(input({
      lastMessage: block([
        "a string",
        entry({ extra: true }),
        entry({ kind: "opinion" }),
        entry({ name: "Not_Kebab" }),
        entry({ description: "two\nlines" }),
      ]),
    }), deps);
    expect(out.dropped).toEqual({ not_an_object: 1, unknown_field: 1, bad_kind: 1, bad_name: 1, bad_description: 1 });
    const more = deriveMemoryProposals(input({
      lastMessage: block([
        entry({ body: "" }),
        entry({ body: "é".repeat(2049) }), // 4098 UTF-8 bytes, 2049 characters
        entry({ targetBundle: "../x" }),
        entry({ targetBundle: "plane-decisions", supersedes: ["../a.md"] }),
        entry({ targetBundle: "plane-decisions", supersedes: ["a.md", "a.md"] }),
      ]),
    }), deps);
    expect(more.dropped).toEqual({ bad_body: 1, body_too_large: 1, bad_target: 1, bad_supersedes: 2 });
    expect(utf8Length("é".repeat(2048))).toBe(4096);
  });

  it("targets only a bundle the revision pinned, at the pinned digest; supersedes is sorted and empty without a target", () => {
    const out = deriveMemoryProposals(input({
      lastMessage: block([
        entry({ name: "targeted", targetBundle: "plane-decisions", supersedes: ["b.md", "a.md"] }),
        entry({ name: "unpinned", targetBundle: "someone-elses", supersedes: ["a.md"] }),
      ]),
    }), deps);
    expect(out.proposals.map((p) => [p.name, p.target, p.supersedes])).toEqual([
      ["targeted", { bundleId: "plane-decisions", bundleDigest: BUNDLE_DIGEST }, ["a.md", "b.md"]],
      ["unpinned", null, []],
    ]);
    expect(out.untargeted).toBe(1);
  });

  it("reads the last block of the message, and a model outside the contract's pattern is null", () => {
    const text = `${block([entry({ name: "first-block" })])}\n\nthen\n\n${block([entry({ name: "second-block" })])}`;
    expect(lastMemoryBlock(text)).toContain("second-block");
    const out = deriveMemoryProposals(input({ lastMessage: text, model: "bad model id" }), deps);
    expect(out.proposals.map((p) => [p.name, p.model])).toEqual([["second-block", null]]);
  });

  it("the same entry gives the same id, and a different body a different one", () => {
    const a = deriveMemoryProposals(input(), deps).proposals[0]!;
    const b = deriveMemoryProposals(input(), deps).proposals[0]!;
    const c = deriveMemoryProposals(input({ lastMessage: block([entry({ body: "Another body." })]) }), deps).proposals[0]!;
    expect(b.proposalId).toBe(a.proposalId);
    expect(c.proposalId).not.toBe(a.proposalId);
    // Same id and body, other description: the id holds, the body digest moves (a conflict for the writer).
    const d = deriveMemoryProposals(input({ lastMessage: block([entry({ description: "Reworded" })]) }), deps).proposals[0]!;
    expect(d.proposalId).toBe(a.proposalId);
    expect(d.bodyDigest).not.toBe(a.bodyDigest);
  });
});
