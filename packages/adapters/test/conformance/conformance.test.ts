/**
 * The adapter conformance matrix (Agent Runtime Registry PR 4). Each in-tree adapter runs the
 * reusable suite in ./suite.ts against a scripted provider: stub binaries for the CLIs, a scripted
 * SDK stream for Claude, the in-process fake. Every value here is FAKE; no provider is launched and
 * no credential is read.
 *
 * The expected matrix is pinned, gaps included: a check that cannot be scripted is `unsupported`
 * with its reason, and a known adapter gap is pinned as `fail` (Bedrock accepts every approval mode
 * although it enforces none) so that fixing it is a visible change.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AssistantId, NormalizedEvent } from "@agent-plane/core";
import { BedrockAdapter, ClaudeAdapter, CodexAdapter, CursorAdapter, FakeAdapter, OpenRouterCodexAdapter } from "../../src/index.js";
import { HOST_LEVEL_CLAIMS, UNIT_PROVEN_CLAIMS, classifyClaims } from "../../src/conformance-evidence.js";
import { drain, runConformance, spec, type CheckResult, type ConformanceSubject } from "./suite.js";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "claude-result-run.json"), "utf8")) as { messages: Array<Record<string, unknown>> };

/** A node script at a fresh path; `marker` is touched when it runs. */
function stub(name: string, body: string): { bin: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "conformance-stub-"));
  const bin = join(dir, name);
  const marker = join(dir, "launched");
  writeFileSync(bin, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, marker };
}

const printLines = (lines: unknown[]) =>
  lines.map((l) => `process.stdout.write(${JSON.stringify(typeof l === "string" ? l : JSON.stringify(l))} + "\\n");`).join("\n");
/** The Codex SDK writes the prompt to stdin and closes it; the stub answers after that. */
const afterStdin = (body: string) => `process.stdin.resume();\nprocess.stdin.on("end", () => {\n${body}\n});`;

const CODEX_OK = [
  { type: "thread.started", thread_id: "FAKE-thread-not-real" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } },
  { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 } },
];
const CODEX_MALFORMED = [{ type: "thread.started", thread_id: "FAKE-thread-not-real" }, { type: "future.event", data: 1 }, "not json at all"];
const CODEX_NO_TERMINAL = [{ type: "thread.started", thread_id: "FAKE-thread-not-real" }, { type: "turn.started" }];
const CODEX_HANG = afterStdin(`${printLines([CODEX_OK[0]])}\nsetInterval(() => {}, 1000);`);

function codexSubject(provider: "openai" | "openrouter"): ConformanceSubject {
  const make = (body: string): { adapter: AgentAdapter; marker: string } => {
    const { bin, marker } = stub("codex", body);
    const adapter = provider === "openai"
      ? new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } })
      : new OpenRouterCodexAdapter("or" as AssistantId, {}, { codexPathOverride: bin });
    return { adapter, marker };
  };
  return {
    provider,
    tripwire: () => { const { adapter, marker } = make(afterStdin("")); return { adapter, launches: () => (existsSync(marker) ? 1 : 0) }; },
    ok: () => ({ adapter: make(afterStdin(printLines(CODEX_OK))).adapter, usage: { input: 80, output: 30 } }),
    malformed: () => make(afterStdin(printLines(CODEX_MALFORMED))).adapter,
    noTerminal: () => make(afterStdin(printLines(CODEX_NO_TERMINAL))).adapter,
    hang: () => make(CODEX_HANG).adapter,
    describe: () => make(afterStdin("")).adapter.describe(),
  };
}

function cursorSubject(): ConformanceSubject {
  const make = (body: string) => { const s = stub("agent", body); return { adapter: new CursorAdapter("cursor" as AssistantId, { command: s.bin }), marker: s.marker }; };
  return {
    provider: "cursor",
    tripwire: () => { const { adapter, marker } = make(""); return { adapter, launches: () => (existsSync(marker) ? 1 : 0) }; },
    ok: () => ({ adapter: make(printLines([{ type: "assistant", text: "hello" }, { type: "result" }])).adapter }),
    malformed: () => make(printLines(["not json at all", { type: "some_future_event", data: 1 }])).adapter,
    // Ignores SIGTERM: cancel() must still close the run (SIGKILL after the grace period).
    hang: () => make(`process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);`).adapter,
    unsupported: { noTerminal: "the CLI's exit status is its terminal signal; there is no separate terminal event to omit" },
    describe: () => make("").adapter.describe(),
  };
}

type ClaudeArgs = { options: { abortController: AbortController; canUseTool?: (tool: string, input: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<{ behavior: string }> } };
/**
 * A scripted Agent SDK `query`. The first message waits a macrotask, as a real CLI does: the adapter
 * drops a settled run's state, so a stream that ended before `events()` was read would be unreadable.
 */
const scriptedQuery = (script: (args: ClaudeArgs) => AsyncGenerator<unknown>, calls?: { n: number }) =>
  ((args: ClaudeArgs) => {
    if (calls) calls.n += 1;
    return (async function* () { await new Promise((r) => setTimeout(r, 5)); yield* script(args); })();
  }) as unknown as typeof query;
const claude = (q: typeof query) => new ClaudeAdapter("claude" as AssistantId, q);
const [INIT, , RESULT] = FIXTURE.messages;

function claudeSubject(): ConformanceSubject {
  return {
    provider: "anthropic",
    tripwire: () => { const calls = { n: 0 }; return { adapter: claude(scriptedQuery(async function* () {}, calls)), launches: () => calls.n }; },
    ok: () => ({ adapter: claude(scriptedQuery(async function* () { for (const m of FIXTURE.messages) yield m; })), usage: { input: 8 + 12_406, output: 1_334 } }),
    malformed: () => claude(scriptedQuery(async function* () { yield { type: "future_type", data: 1 }; yield { no_type: true }; })),
    noTerminal: () => claude(scriptedQuery(async function* () { yield INIT; })),
    hang: () => claude(scriptedQuery(async function* (args) {
      yield INIT;
      await new Promise((_, reject) => args.options.abortController.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    })),
    relayDeny: async () => {
      let answer: string | undefined;
      const adapter = claude(scriptedQuery(async function* (args) {
        yield INIT;
        const decision = await args.options.canUseTool!("Bash", { command: "rm -rf ./dist" }, { signal: new AbortController().signal });
        answer = decision.behavior;
        yield RESULT;
      }));
      const handle = await adapter.start(spec("prompt-on-escalation"));
      for await (const e of adapter.events(handle)) {
        if (e.type === "approval.requested") await adapter.send(handle, { kind: "approval", requestId: (e.payload as { requestId: string }).requestId, approved: false });
      }
      return answer === "deny";
    },
    describe: () => claude(scriptedQuery(async function* () {})).describe(),
  };
}

function fakeSubject(): ConformanceSubject {
  return {
    provider: "fake",
    tripwire: () => ({ adapter: new FakeAdapter("fake" as AssistantId), launches: () => 0 }),
    ok: () => ({ adapter: new FakeAdapter("fake" as AssistantId), usage: { input: 1200, output: 450 } }),
    hang: () => new FakeAdapter("fake" as AssistantId, { ok: true, delayMs: 200, events: Array.from({ length: 100 }, () => ({ type: "message" as const, summary: "tick" })) }),
    relayDeny: async () => {
      const adapter = new FakeAdapter("fake" as AssistantId);
      const handle = await adapter.start(spec("prompt-on-escalation", "[FAKE:APPROVAL]"));
      const events: NormalizedEvent[] = [];
      for await (const e of adapter.events(handle)) {
        events.push(e);
        if (e.type === "approval.requested") await adapter.send!(handle, { kind: "approval", requestId: (e.payload as { requestId: string }).requestId, approved: false });
      }
      // The scripted file change after the approval point must not have happened.
      return (events.at(-1)?.payload as { reason?: string }).reason === "denied" && !events.some((e) => e.type === "file.changed");
    },
    unsupported: { malformed: "in-process double: there is no provider output to parse", noTerminal: "in-process double: the adapter writes the terminal event itself" },
    describe: () => new FakeAdapter("fake" as AssistantId).describe(),
  };
}

function bedrockSubject(): ConformanceSubject {
  const make = () => {
    const adapter = new BedrockAdapter("bedrock" as AssistantId, { agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/FAKE-not-real", region: "us-east-1" });
    const calls = { n: 0 };
    // The AgentCore client is replaced by a tripwire: nothing can reach AWS.
    (adapter as unknown as { client: { send(): Promise<never> } }).client = { send: async () => { calls.n += 1; throw new Error("tripwire: AgentCore invoke"); } };
    return { adapter, launches: () => calls.n };
  };
  return {
    provider: "bedrock",
    tripwire: make,
    unsupported: {
      ok: "no scripted AgentCore response stream in this suite",
      malformed: "no scripted AgentCore response stream in this suite",
      noTerminal: "no scripted AgentCore response stream in this suite",
      hang: "no scripted AgentCore response stream in this suite",
    },
    describe: () => make().adapter.describe(),
  };
}

const matrix = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.check, r.status]));

describe("adapter conformance matrix (scripted providers, unit-level evidence only)", () => {
  it("anthropic (scripted Agent SDK stream)", async () => {
    const results = await runConformance(claudeSubject());
    expect(matrix(results), JSON.stringify(results, null, 1)).toEqual({
      "approval-refusal": "unsupported", claims: "pass", "host-claims": "pass", "claim:approvalRelay": "pass", "claim:usageAccounting:cumulative": "pass",
      completion: "pass", "completion:no-terminal": "pass", "malformed-output": "pass", cancel: "pass", redaction: "pass",
    });
  });

  it.each(["openai", "openrouter"] as const)("%s (stub codex binary through the SDK)", async (provider) => {
    const results = await runConformance(codexSubject(provider));
    expect(matrix(results), JSON.stringify(results, null, 1)).toEqual({
      "approval-refusal:prompt-on-escalation": "pass", claims: "pass", "host-claims": "pass", "claim:usageAccounting:cumulative": "pass",
      completion: "pass", "completion:no-terminal": "pass", "malformed-output": "pass", cancel: "pass", redaction: "pass",
    });
  }, 30_000);

  it("cursor (stub agent binary; cancel survives a CLI that ignores SIGTERM)", async () => {
    const results = await runConformance(cursorSubject(), { cancelBoundMs: 4_000 });
    expect(matrix(results), JSON.stringify(results, null, 1)).toEqual({
      "approval-refusal:prompt-on-escalation": "pass", "approval-refusal:read-only": "pass", claims: "pass", "host-claims": "pass",
      completion: "pass", "completion:no-terminal": "unsupported", "malformed-output": "pass", cancel: "pass", redaction: "pass",
    });
  }, 30_000);

  it("fake (in-process double)", async () => {
    const results = await runConformance(fakeSubject());
    expect(matrix(results), JSON.stringify(results, null, 1)).toEqual({
      "approval-refusal": "unsupported", claims: "pass", "host-claims": "pass", "claim:approvalRelay": "pass", "claim:usageAccounting:cumulative": "pass",
      completion: "pass", "completion:no-terminal": "unsupported", "malformed-output": "unsupported", cancel: "pass", redaction: "pass",
    });
  });

  it("bedrock: the known gap is pinned (it enforces no approval mode and refuses none)", async () => {
    const results = await runConformance(bedrockSubject());
    expect(matrix(results), JSON.stringify(results, null, 1)).toEqual({
      "approval-refusal:auto-approve": "fail", "approval-refusal:prompt-on-escalation": "fail", "approval-refusal:read-only": "fail",
      claims: "pass", "host-claims": "pass",
      completion: "unsupported", "completion:no-terminal": "unsupported", "malformed-output": "unsupported", cancel: "unsupported", redaction: "pass",
    });
  });
});

describe("claim evidence is honest", () => {
  it("a host-level claim is never listed as unit-proven", () => {
    for (const claims of Object.values(UNIT_PROVEN_CLAIMS)) for (const c of claims) expect(HOST_LEVEL_CLAIMS).not.toContain(c);
  });

  it("the agent-user claim is a host claim, so a passing mocked launch never makes it proven", async () => {
    const launcher = { sudo: "/usr/bin/sudo", user: "aos-agent", group: "aos", wrapper: "/usr/local/libexec/aos/run-as-agent", executable: "/opt/aos/claude" };
    const manifest = await new ClaudeAdapter("claude" as AssistantId, undefined, { agentLauncher: launcher }).describe();
    expect(classifyClaims("anthropic", manifest)).toEqual({ provenUnit: ["approvalRelay", "usageAccounting:cumulative"], unprovenUnit: [], host: ["agentUser"] });
  });

  it("a claim with no conformance evidence is reported, not accepted", () => {
    expect(classifyClaims("cursor", { harness: { usageAccounting: "cumulative", toolGating: "preventive", approvalRelay: false, processIsolation: "none" } }).unprovenUnit)
      .toEqual(["toolGating:preventive", "usageAccounting:cumulative"]);
  });

  it("a cancelled Codex stub run ends not ok (no fabricated success after the abort)", async () => {
    const { bin } = stub("codex", CODEX_HANG);
    const adapter = new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } });
    const handle = await adapter.start(spec());
    const events = drain(adapter, handle, 5_000);
    await new Promise((r) => setTimeout(r, 100));
    await adapter.cancel(handle);
    expect((await events).at(-1)).toMatchObject({ type: "run.ended", payload: { ok: false } });
  });
});
