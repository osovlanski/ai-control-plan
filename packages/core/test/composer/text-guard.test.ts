import { describe, expect, it } from "vitest";
import { createTextGuard } from "../../src/index.js";
import { bounded } from "../../src/composer/explain.js";

describe("text guard (§4.4)", () => {
  const guard = createTextGuard(["fixture-host.example", "box", "127.0.0.1"]);
  it.each([
    ["plain evidence", "tags matched: coding, typescript", true],
    ["an ISO timestamp", "quota blocked until 2026-10-18T09:00:00Z", false],
    ["a space-separated timestamp", "seen 2026-10-18 09:00", false],
    ["a date alone", "pricing 2026-10-18", true],
    ["a home path", "skill at /home/someone/.claude", false],
    ["a macOS path", "under /Users/someone/x", false],
    ["a tmp path", "(/tmp/scratch)", false],
    ["a tilde path", "see ~/notes", false],
    ["a Windows path", "at C:\\Users\\x", false],
    ["a repo-relative path", "marker package.json", true],
    ["a forbidden hostname", "rendered on fixture-host.example", false],
    ["a hostname, any case", "FIXTURE-HOST.EXAMPLE answered", false],
    ["a hostname label prefix", "box.local refused", false],
    ["a loopback host", "http://127.0.0.1:4100/api", false],
    ["a word containing a hostname", "inbox and boxes", true],
    ["a lone surrogate", "bad \ud800 text", false],
  ])("%s", (_name, text, ok) => {
    expect(guard(text)).toBe(ok);
  });

  it("no hostnames: only shapes are checked", () => {
    expect(createTextGuard([])("any host name")).toBe(true);
    expect(createTextGuard(["", "  "])("any host name")).toBe(true);
  });

  it("bounded never splits a surrogate pair", () => {
    const text = `${"a".repeat(9)}\u{1F600}tail`;
    const cut = bounded(text, 11);
    expect(cut.length).toBeLessThanOrEqual(11);
    expect(cut).toBe(`${"a".repeat(9)}…`);
    expect(bounded("short", 11)).toBe("short");
  });
});
