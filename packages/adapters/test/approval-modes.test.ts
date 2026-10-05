import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantId, NormalizedEvent, PermissionPolicy, RunSpec } from "@agent-plane/core";
import { CodexAdapter, CursorAdapter, OpenRouterCodexAdapter } from "../src/index.js";
import { codexPermissions } from "../src/codex-permissions.js";

const spec = (mode: PermissionPolicy["mode"], workdir = tmpdir()): RunSpec => ({
  taskId: "AG-modes" as never,
  prompt: "prompt",
  workdir,
  permissionPolicy: { mode } as PermissionPolicy,
  env: { redactionRules: [], maxRuntimeMs: 5_000 },
});

/** A stand-in `codex` binary: records the argv the SDK passes, then ends one turn. */
function fakeCodex(): { bin: string; argvFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "codex-modes-"));
  const argvFile = join(dir, "argv.json");
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on("end", () => {
  for (const e of [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }])
    process.stdout.write(JSON.stringify(e) + "\\n");
});
`);
  chmodSync(bin, 0o755);
  return { bin, argvFile };
}

async function drain(adapter: CodexAdapter | OpenRouterCodexAdapter, run: RunSpec): Promise<NormalizedEvent[]> {
  const handle = await adapter.start(run);
  const events: NormalizedEvent[] = [];
  for await (const e of adapter.events(handle)) events.push(e);
  return events;
}

const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

describe("Codex honours the workspace approval mode", () => {
  it("maps each mode to the strictest SDK setting, refusing prompt-on-escalation", () => {
    expect(codexPermissions({ mode: "auto-approve" })).toEqual({ sandboxMode: "workspace-write", approvalPolicy: "never" });
    expect(codexPermissions({ mode: "read-only" })).toEqual({ sandboxMode: "read-only", approvalPolicy: "never" });
    expect(() => codexPermissions({ mode: "prompt-on-escalation" })).toThrow(/prompt-on-escalation/);
  });

  it.each([
    ["read-only", "read-only"],
    ["auto-approve", "workspace-write"],
  ] as const)("SDK path: %s launches codex exec with --sandbox %s", async (mode, sandbox) => {
    const { bin, argvFile } = fakeCodex();
    const events = await drain(new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } }), spec(mode));
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(argv.slice(0, 2)).toEqual(["exec", "--experimental-json"]);
    expect(flag(argv, "--sandbox")).toBe(sandbox);
    expect(argv).toContain('approval_policy="never"');
    expect(events.at(-1)).toMatchObject({ type: "run.ended", payload: { ok: true } });
  });

  it("SDK path: resume carries the same sandbox", async () => {
    const { bin, argvFile } = fakeCodex();
    const adapter = new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } });
    const handle = await adapter.resume("t" as never, spec("read-only"));
    for await (const _ of adapter.events(handle)) void _;
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(flag(argv, "--sandbox")).toBe("read-only");
    expect(argv.slice(-2)).toEqual(["resume", "t"]);
  });

  it("refuses prompt-on-escalation before launching anything (SDK, resume, app-server)", async () => {
    const { bin, argvFile } = fakeCodex();
    await expect(new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } }).start(spec("prompt-on-escalation")))
      .rejects.toThrow(/prompt-on-escalation/);
    await expect(new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } }).resume("t" as never, spec("prompt-on-escalation")))
      .rejects.toThrow(/prompt-on-escalation/);
    await expect(new CodexAdapter("codex" as AssistantId, { appServerInput: true, codex: { codexPathOverride: bin } }).start(spec("prompt-on-escalation")))
      .rejects.toThrow(/prompt-on-escalation/);
    expect(existsSync(argvFile)).toBe(false);
  });

  it("OpenRouter inherits the Codex mapping", async () => {
    const adapter = new OpenRouterCodexAdapter("or" as AssistantId);
    await expect(adapter.start(spec("prompt-on-escalation"))).rejects.toThrow(/prompt-on-escalation/);
  });
});

describe("Cursor refuses modes it cannot enforce", () => {
  it.each(["read-only", "prompt-on-escalation"] as const)("%s is refused before the CLI starts", async (mode) => {
    const marker = join(mkdtempSync(join(tmpdir(), "cursor-modes-")), "ran");
    const bin = `${marker}.sh`;
    writeFileSync(bin, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(bin, 0o755);
    await expect(new CursorAdapter("cursor" as AssistantId, { command: bin }).start(spec(mode))).rejects.toThrow(new RegExp(mode));
    expect(existsSync(marker)).toBe(false);
  });
});
