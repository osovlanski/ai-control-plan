import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every agent session reads docs/PROJECT_MEMORY.md at startup (AGENTS.md), so its size is
// paid on every session. Outcome sections belong in docs/project-memory-log.md instead.
const MAX_BYTES = 16 * 1024;
const coreUrl = new URL("../../../docs/PROJECT_MEMORY.md", import.meta.url);

describe("docs/PROJECT_MEMORY.md", () => {
  const text = readFileSync(fileURLToPath(coreUrl), "utf8");

  it(`stays under ${MAX_BYTES} bytes`, () => {
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("points at the outcome log", () => {
    expect(text).toContain("docs/project-memory-log.md");
  });
});
