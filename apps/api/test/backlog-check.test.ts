// P0-9: scripts/backlog-check.mjs validates docs/progress/backlog.yaml (auto copilot plan §C.3).
// Driven as a process, the way the acceptance runner and itay call it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/backlog-check.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "backlog-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let n = 0;
function check(yaml: string, extra: string[] = []) {
  const file = path.join(dir, `b${n++}.yaml`);
  writeFileSync(file, yaml);
  return run([file, ...extra]);
}

const ACCEPT = `
    acceptance:
      commands:
        - { run: "pnpm install --offline --frozen-lockfile", replaySafe: true }
        - { run: "pnpm test", replaySafe: true, timeoutSec: 900 }
      writable: ["node_modules"]`;

function item(id: string, over: Record<string, string> = {}, acceptance = ACCEPT) {
  const f: Record<string, string> = {
    title: `"t ${id}"`, phase: "p", repo: "ai-control-plan", size: "S", depends_on: "[]",
    files: '["a.ts"]', lane: "oci-loop", profile: "auto", night: "true", ...over,
  };
  const body = Object.entries(f).map(([k, v]) => `    ${k}: ${v}`).join("\n");
  return `  - id: ${id}\n${body}${acceptance}\n`;
}
const doc = (...items: string[]) => `version: 1\nitems:\n${items.join("")}`;

describe("backlog-check", () => {
  it("passes on the committed backlog and every oci-loop item there has acceptance", () => {
    const r = run([]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^backlog-check: PASS, \d+ items \(oci-loop [1-9]\d*, /);
  });

  it("passes a minimal valid backlog", () => {
    const r = check(doc(item("a-1"), item("b-2", { depends_on: "[a-1]", lane: "owner" }, "")));
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 items (oci-loop 1, manual-cloud 0, owner 1); 2 estimated scope points; 2 night-eligible");
  });

  it("refuses an oci-loop item with no acceptance", () => {
    const r = check(doc(item("a-1", {}, "")));
    expect(r.code).toBe(1);
    expect(r.err).toContain("items[0] (a-1).acceptance: required for lane oci-loop");
  });

  it("refuses a command without an explicit replaySafe, an empty command list and empty writable", () => {
    const noFlag = check(doc(item("a-1", {}, `
    acceptance:
      commands: [{ run: "pnpm test" }]
      writable: ["dist"]`)));
    expect(noFlag.code).toBe(1);
    expect(noFlag.err).toContain("commands[0].replaySafe: must be set explicitly");

    const empty = check(doc(item("a-1", {}, `
    acceptance:
      commands: []
      writable: []`)));
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("acceptance.commands: must be a non-empty list");
    expect(empty.err).toContain("acceptance.writable: must be a non-empty list");
  });

  it("refuses writable paths that escape the snapshot or cover all of it", () => {
    for (const bad of ["/tmp", "../x", ".", "**", ".git/hooks", "~/x"]) {
      const r = check(doc(item("a-1", {}, `
    acceptance:
      commands: [{ run: "pnpm test", replaySafe: true }]
      writable: ["${bad}"]`)));
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toContain("acceptance.writable[0]:");
    }
  });

  it("accepts a {file} writable entry and checks its path like a directory's", () => {
    const ok = check(doc(item("a-1", {}, `
    acceptance:
      commands: [{ run: "npm test", replaySafe: false }]
      writable: ["node_modules", { file: "status.json" }]`)));
    expect(ok.code).toBe(0);
    const bad = check(doc(item("a-1", {}, `
    acceptance:
      commands: [{ run: "npm test", replaySafe: false }]
      writable: [{ file: "../status.json" }, { path: "x" }, { file: "a.json" }, { file: "a.json" }]`)));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("writable[0].file: must not contain '..'");
    expect(bad.err).toContain("writable[1]: unknown field 'path'");
    expect(bad.err).toContain("acceptance.writable: duplicate path");
  });

  it("refuses a dependency install that could reach the network", () => {
    const r = check(doc(item("a-1", {}, `
    acceptance:
      commands: [{ run: "npm ci", replaySafe: true }]
      writable: ["node_modules"]`)));
    expect(r.code).toBe(1);
    expect(r.err).toContain("a dependency install must pass --offline");
  });

  it("refuses unknown fields, so a misspelt replaySafe or a status field cannot slip through", () => {
    const r = check(doc(item("a-1", { status: "done" }, `
    acceptance:
      commands: [{ run: "pnpm test", replaysafe: true, replaySafe: false }]
      writable: ["dist"]`)));
    expect(r.code).toBe(1);
    expect(r.err).toContain("items[0] (a-1): unknown field 'status'");
    expect(r.err).toContain("commands[0]: unknown field 'replaysafe'");
  });

  it("refuses bad ids, duplicates, unknown dependencies and cycles", () => {
    const r = check(doc(
      item("Bad_Id"),
      item("a-1", { depends_on: "[b-2]" }),
      item("b-2", { depends_on: "[a-1, missing]" }),
      item("a-1"),
    ));
    expect(r.code).toBe(1);
    expect(r.err).toContain("items[0] (Bad_Id).id: must match");
    expect(r.err).toContain("duplicate id 'a-1'");
    expect(r.err).toContain("b-2.depends_on: unknown id 'missing'");
    expect(r.err).toMatch(/depends_on cycle: (a-1 -> b-2 -> a-1|b-2 -> a-1 -> b-2)/);
  });

  it("refuses bad enums and a missing required field", () => {
    const r = check(doc(item("a-1", { repo: "other", size: "XL", lane: "night", night: "yes" })).replace("    profile: auto\n", ""));
    expect(r.code).toBe(1);
    expect(r.err).toContain(".repo: one of ai-control-plan, cockpit");
    expect(r.err).toContain(".size: one of S, M, L");
    expect(r.err).toContain(".lane: one of oci-loop, manual-cloud, owner");
    expect(r.err).toContain(".night: must be true or false");
    expect(r.err).toContain("missing 'profile'");
  });

  it("prints a revision digest that ignores key order and changes with content", () => {
    const a = check(doc(item("a-1")), ["--digests"]);
    const reordered = check(doc(item("a-1").replace('    phase: p\n', "").replace("    profile: auto\n", "    profile: auto\n    phase: p\n")), ["--digests"]);
    const changed = check(doc(item("a-1", { size: "M" })), ["--digests"]);
    const digest = (out: string) => out.split("\n")[0];
    expect(digest(a.out)).toMatch(/^a-1 [0-9a-f]{64}$/);
    expect(digest(reordered.out)).toBe(digest(a.out));
    expect(digest(changed.out)).not.toBe(digest(a.out));
  });

  it("exits 2 on an unreadable file or a duplicate YAML key", () => {
    expect(run([path.join(dir, "absent.yaml")]).code).toBe(2);
    expect(check("version: 1\nversion: 1\nitems: []\n").code).toBe(2);
  });
});
