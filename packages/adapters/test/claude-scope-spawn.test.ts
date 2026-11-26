/**
 * qcq-04b (review packet 2.6.1, section 5 test 5 "r6 delayed spawn"): the Claude adapter's plane-lane
 * scope and its spawn-closed report, with an injectable query stream and a recording `systemd-run`.
 *
 * `systemd-run` here is a script that records its argv and then runs the command it was given, as the
 * real one does once the scope exists. The real scope is driven on a systemd host.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId, RunSpec } from "@agent-plane/core";
import type { Options, query, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../src/index.js";

let dir: string, systemdRun: string, log: string, SPEC: RunSpec;
const UNIT = "aos-att-att_0a1b2c3d";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-scope-"));
  log = join(dir, "systemd-run.log");
  systemdRun = join(dir, "systemd-run");
  // Record the argv, then exec what follows `--` (the scope's command).
  writeFileSync(systemdRun, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n`);
  chmodSync(systemdRun, 0o755);
  SPEC = { taskId: "AG-1" as RunSpec["taskId"], prompt: "hi", workdir: dir, permissionPolicy: { mode: "auto-approve" },
    env: { redactionRules: [], maxRuntimeMs: 60_000 }, scope: { unit: UNIT } };
});

let release: () => void = () => {};
afterEach(() => release());

/** A `query` that holds before anything spawns, as the SDK does until it launches the CLI. */
function held(): { fake: typeof query; options: () => Options } {
  let seen: Options | undefined;
  const open = new Promise<void>((r) => { release = r; });
  const fake = ((input: { options?: Options }) => {
    seen = input.options;
    return (async function* (): AsyncGenerator<never> { await open; yield* []; })();
  }) as unknown as typeof query;
  return { fake, options: () => seen! };
}
const spawnOpts = (command: string, args: string[]): SpawnOptions =>
  ({ command, args, cwd: dir, env: { PATH: process.env.PATH }, signal: new AbortController().signal }) as SpawnOptions;
async function until(what: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) { if (what()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${label}`);
}

describe("Claude adapter, plane-lane scope (qcq-04b)", () => {
  it("declares scopedSpawn and launches the CLI inside the named scope", async () => {
    const { fake, options } = held();
    const adapter = new ClaudeAdapter("c" as AssistantId, fake, { systemdRun });
    expect(adapter.scopedSpawn).toBe(true);
    await adapter.start(SPEC);
    const child = options().spawnClaudeCodeProcess!(spawnOpts("/bin/true", ["--output-format", "stream-json"]));
    await until(() => existsSync(log), "the systemd-run call");
    expect(readFileSync(log, "utf8").trim()).toBe(`--user --scope --quiet --collect --unit=${UNIT} -- /bin/true --output-format stream-json`);
    (child as unknown as { kill: () => void }).kill();
  });

  it("refuses a scope beside runAs agent, and a unit that is not an aos-att name", async () => {
    const adapter = new ClaudeAdapter("c" as AssistantId, held().fake, { systemdRun });
    await expect(adapter.start({ ...SPEC, scope: { unit: "aos-run-x" } })).rejects.toThrow(/not an aos-att unit name/);
    await expect(adapter.start({ ...SPEC, scope: { unit: "aos-att-x;rm" } })).rejects.toThrow(/not an aos-att unit name/);
    const agentLauncher = { sudo: "/bin/false", user: "aos-agent", group: "aos", wrapper: "/usr/local/lib/aos/run-as-agent", executable: "/usr/local/lib/aos/claude" };
    const agent = new ClaudeAdapter("c" as AssistantId, held().fake, { systemdRun, agentLauncher });
    await expect(agent.start({ ...SPEC, runAs: { kind: "agent", unit: "att_0a1b2c3d" } })).rejects.toThrow(/takes no plane scope/);
  });

  it("delayed spawn: start returned and nothing spawned is no proof; spawnClosed only once the stream ended and the child exited", async () => {
    const { fake, options } = held();
    const adapter = new ClaudeAdapter("c" as AssistantId, fake, { systemdRun });
    const handle = await adapter.start(SPEC);
    // `start` has returned, no process exists yet: the spawn path is open.
    expect(adapter.providerProcess(handle)).toBeUndefined();
    expect(adapter.spawnClosed(handle)).toBe(false);
    // The SDK spawns: a child that outlives the stream for a moment.
    options().spawnClaudeCodeProcess!(spawnOpts("/bin/sh", ["-c", "sleep 0.3"]));
    await until(() => adapter.providerProcess(handle) !== undefined, "the spawned provider");
    expect(adapter.spawnClosed(handle)).toBe(false);
    // The stream ends while the child still runs: still open.
    release();
    const events = adapter.events(handle);
    for await (const _ of events) { /* drain */ }
    expect(adapter.spawnClosed(handle)).toBe(false);
    // The child exits: closed.
    await until(() => adapter.spawnClosed(handle), "spawnClosed after the child exits");
  });

  it("a stream that ends without ever spawning closes the spawn path", async () => {
    const { fake } = held();
    const adapter = new ClaudeAdapter("c" as AssistantId, fake, { systemdRun });
    const handle = await adapter.start(SPEC);
    expect(adapter.spawnClosed(handle)).toBe(false);
    release();
    for await (const _ of adapter.events(handle)) { /* drain */ }
    expect(adapter.spawnClosed(handle)).toBe(true);
  });

  it("a spawn that errors (no such systemd-run) does not hold the path open", async () => {
    const { fake, options } = held();
    const adapter = new ClaudeAdapter("c" as AssistantId, fake, { systemdRun: join(dir, "missing-systemd-run") });
    const handle = await adapter.start(SPEC);
    options().spawnClaudeCodeProcess!(spawnOpts("/bin/true", []));
    release();
    for await (const _ of adapter.events(handle)) { /* drain */ }
    await until(() => adapter.spawnClosed(handle), "spawnClosed after a failed spawn");
  });
});
