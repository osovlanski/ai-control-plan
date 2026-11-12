/**
 * P0-A2 (docs/agentic-os-auto-copilot-plan.md §C.0): a run with `RunSpec.runAs` launches through
 * the plane's one sudoers command as the agent user, with none of the plane's environment, and a
 * run that cannot be launched that way is refused rather than started as the plane user.
 *
 * `sudo` here is a script that records what it was asked to run. The real wrapper, sudoers rule
 * and systemd scope are driven on the host (G26).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId, RunSpec } from "@agent-plane/core";
import type { Options, query, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { agentLaunch, ClaudeAdapter, stopAgentUnit, type AgentLauncher } from "../src/index.js";

let dir: string, launcher: AgentLauncher, log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-launch-"));
  log = join(dir, "sudo.log");
  const sudo = join(dir, "sudo");
  // One line per call: the argv, then the environment names it was given.
  writeFileSync(sudo, `#!/bin/sh\n{ printf 'ARGV'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\nENV\\t%s\\n' "$(env | cut -d= -f1 | sort | tr '\\n' ' ')"; } >> "${log}"\n`);
  chmodSync(sudo, 0o755);
  launcher = { sudo, user: "aos-agent", group: "aos", wrapper: "/usr/local/lib/aos/run-as-agent", executable: "/usr/local/lib/aos/claude" };
});
afterEach(() => { delete process.env.FAKE_PLANE_SECRET; });

let SPEC: RunSpec, AGENT: RunSpec;
beforeEach(() => {
  // The worktree: any existing directory, since the fake sudo does not check it.
  SPEC = {
    taskId: "AG-1" as RunSpec["taskId"], prompt: "hi", workdir: dir,
    permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 90_500 },
  };
  AGENT = { ...SPEC, runAs: { kind: "agent", unit: "es_1234-abcd" } };
});

let release: () => void = () => {};
afterEach(() => release());

/** A `query` that hands back the options it was given and stays open, as a live run does, until the test ends. */
function capture(): { fake: typeof query; options: () => Options } {
  let seen: Options | undefined;
  const open = new Promise<void>((r) => { release = r; });
  const fake = ((input: { options?: Options }) => {
    seen = input.options;
    return (async function* (): AsyncGenerator<never> { await open; yield* []; })();
  }) as unknown as typeof query;
  return { fake, options: () => seen! };
}

const lines = async (n: number): Promise<string[]> => {
  for (let i = 0; i < 200; i++) {
    const out = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    if (out.length >= n) return out;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`sudo was called fewer than ${n / 2} time(s)`);
};

describe("Claude adapter, agent-user launch", () => {
  it("declares harness.agentUser only when a launcher is configured", async () => {
    const { fake } = capture();
    expect((await new ClaudeAdapter("c" as AssistantId, fake).describe()).harness?.agentUser).toBeUndefined();
    expect((await new ClaudeAdapter("c" as AssistantId, fake, { agentLauncher: launcher }).describe()).harness?.agentUser).toBe(true);
  });

  it("spawns sudo -> wrapper -> the agent-executable CLI, bounded, with none of the plane's environment", async () => {
    process.env.FAKE_PLANE_SECRET = "FAKE-plane-secret-not-real";
    const { fake, options } = capture();
    const adapter = new ClaudeAdapter("c" as AssistantId, fake, { agentLauncher: launcher });
    const handle = await adapter.start(AGENT);
    expect(options().pathToClaudeCodeExecutable).toBe("/usr/local/lib/aos/claude");
    options().spawnClaudeCodeProcess!({
      command: "/usr/local/lib/aos/claude", args: ["--output-format", "stream-json"], cwd: AGENT.workdir,
      env: { ...process.env, ANOTHER: "FAKE-sdk-env-not-real" }, signal: new AbortController().signal,
    } as SpawnOptions);
    const [argv, env] = await lines(2);
    expect(argv!.split("\t").slice(1)).toEqual([
      "-n", "-u", "aos-agent", "-g", "aos", "--", "/usr/local/lib/aos/run-as-agent",
      "run", "es_1234-abcd", "91", dir, "--",
      "/usr/local/lib/aos/claude", "--output-format", "stream-json",
    ]);
    const names = env!.split("\t")[1]!.trim().split(" ");
    expect(names).not.toContain("FAKE_PLANE_SECRET");
    expect(names).not.toContain("ANOTHER");
    expect(names).not.toContain("AGENT_PLANE_INCARNATION");
    expect(names).not.toContain("HOME");
    const proc = adapter.providerProcess(handle)!;
    expect(proc.agentUnit).toBe("es_1234-abcd");
    await proc.stop!();
    expect((await lines(4))[2]!.split("\t").slice(1)).toEqual(["-n", "-u", "aos-agent", "-g", "aos", "--", "/usr/local/lib/aos/run-as-agent", "stop", "es_1234-abcd"]);
  });

  it("stops the scope by name on cancel, because the plane user may not signal sudo", async () => {
    const { fake, options } = capture();
    const adapter = new ClaudeAdapter("c" as AssistantId, fake, { agentLauncher: launcher });
    const handle = await adapter.start(AGENT);
    options().spawnClaudeCodeProcess!({ command: "/x", args: [], cwd: AGENT.workdir, env: {}, signal: new AbortController().signal } as SpawnOptions);
    await lines(2);
    await adapter.cancel(handle);
    expect((await lines(4))[2]).toMatch(/\tstop\tes_1234-abcd$/);
  });

  it("launches an ordinary run exactly as before", async () => {
    const { fake, options } = capture();
    const adapter = new ClaudeAdapter("c" as AssistantId, fake, { agentLauncher: launcher });
    const handle = await adapter.start(SPEC);
    expect(options().pathToClaudeCodeExecutable).toBeUndefined();
    options().spawnClaudeCodeProcess!({ command: process.execPath, args: ["-e", ""], cwd: dir, env: process.env, signal: new AbortController().signal } as SpawnOptions);
    const proc = adapter.providerProcess(handle)!;
    expect(proc.stop).toBeUndefined();
    expect(proc.agentUnit).toBeUndefined();
    expect(existsSync(log)).toBe(false);
  });

  it("refuses rather than start as the plane user", async () => {
    const { fake } = capture();
    await expect(new ClaudeAdapter("c" as AssistantId, fake).start(AGENT)).rejects.toThrow(/no agent launcher configured/);
    expect(() => agentLaunch({ ...AGENT, runAs: { kind: "agent", unit: "../x" } }, launcher)).toThrow(/safe unit name/);
    expect(() => agentLaunch({ ...AGENT, secretEnv: { K: "FAKE-secret-not-real" } }, launcher)).toThrow(/no secret environment/);
    expect(() => agentLaunch({ ...AGENT, env: { redactionRules: [], maxRuntimeMs: 14_401_000 } }, launcher)).toThrow(/runtime bound/);
    expect(agentLaunch(SPEC, undefined)).toBeUndefined();
    expect(existsSync(log)).toBe(false);
  });

  it("stopAgentUnit never throws and ignores an unsafe unit", async () => {
    await stopAgentUnit({ ...launcher, sudo: join(dir, "missing-sudo") }, "es_1");
    await stopAgentUnit(launcher, "bad unit");
    expect(existsSync(log)).toBe(false);
  });
});
