/**
 * Agent Runtime Registry PR 4: Cursor install presence is not authentication. `agent --version`
 * succeeding proves the CLI runs, never that an account is signed in.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { CursorAdapter, cursorAuth } from "../src/index.js";

function stubCli(body: string): string {
  const bin = join(mkdtempSync(join(tmpdir(), "cursor-auth-")), "agent");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("Cursor auth state", () => {
  it("an installed CLI reports unknown, not ok", async () => {
    const manifest = await new CursorAdapter("cursor" as AssistantId, { command: stubCli('echo "2026.11.01-FAKE"') }).describe();
    expect(manifest.core.auth).toEqual({ state: "unknown", account: "cursor CLI installed; sign-in not verified" });
    expect(manifest.providerDetail.version).toBe("2026.11.01-FAKE");
  });

  it("an absent CLI reports missing", async () => {
    const manifest = await new CursorAdapter("cursor" as AssistantId, { command: join(mkdtempSync(join(tmpdir(), "cursor-none-")), "agent") }).describe();
    expect(manifest.core.auth.state).toBe("missing");
  });

  it("a CLI that fails --version reports missing", async () => {
    const manifest = await new CursorAdapter("cursor" as AssistantId, { command: stubCli("exit 3") }).describe();
    expect(manifest.core.auth.state).toBe("missing");
  });

  it("no CLI output, environment variable or file ever produces ok", async () => {
    const saved = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "FAKE-cursor-key-not-real";
    try {
      for (const version of ["1.0.0", "signed in as someone", "authenticated", "ok"]) expect(cursorAuth(version).state).toBe("unknown");
      const manifest = await new CursorAdapter("cursor" as AssistantId, { command: stubCli('echo "Logged in"') }).describe();
      expect(manifest.core.auth.state).toBe("unknown");
      expect(JSON.stringify(manifest)).not.toContain("FAKE-cursor-key-not-real");
    } finally {
      if (saved === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = saved;
    }
  });

  it("describe() only asks for the version: it never starts a login or a prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-argv-"));
    const log = join(dir, "argv.log");
    const manifest = await new CursorAdapter("cursor" as AssistantId, { command: stubCli(`echo "$@" >> ${log}; echo 1.0.0`) }).describe();
    expect(manifest.core.auth.state).toBe("unknown");
    expect((await import("node:fs")).readFileSync(log, "utf8").trim().split("\n")).toEqual(["--version"]);
  });
});
