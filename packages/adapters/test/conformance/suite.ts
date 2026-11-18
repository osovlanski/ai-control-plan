/**
 * Reusable adapter conformance suite (Agent Runtime Registry design §D, PR 4).
 *
 * Every check runs against a SCRIPTED provider: a fake, a stub binary or a scripted SDK stream.
 * Nothing here launches a real provider, reads a real credential or spends quota. The results are
 * unit-level evidence about the adapter's code only. They never prove a host property (sandbox,
 * process isolation, the agent Unix user): `host-claims` is reported `unsupported` whenever an
 * adapter makes one, never `pass`.
 *
 * A subject supplies what its provider can script; a scenario it cannot script is reported
 * `unsupported` with the reason, so the matrix in conformance.test.ts states every gap.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accumulateInRun,
  NotSupportedError,
  runtimeKindFor,
  type AgentAdapter,
  type ApprovalMode,
  type CapabilityManifest,
  type NormalizedEvent,
  type RunHandle,
  type RunSpec,
} from "@agent-plane/core";
import { classifyClaims, UNIT_PROVEN_CLAIMS } from "../../src/conformance-evidence.js";

export type CheckStatus = "pass" | "fail" | "unsupported";
export interface CheckResult { check: string; status: CheckStatus; detail: string }

/** Secret-shaped values put in the environment while `describe()` runs: the manifest must carry none. */
export const FAKE_SECRETS: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC_API_KEY: "FAKE-anthropic-key-not-real",
  OPENAI_API_KEY: "FAKE-openai-key-not-real",
  CODEX_API_KEY: "FAKE-codex-key-not-real",
  OPENROUTER_API_KEY: "FAKE-openrouter-key-not-real",
  CURSOR_API_KEY: "FAKE-cursor-key-not-real",
  AWS_SECRET_ACCESS_KEY: "FAKE-aws-secret-not-real",
  AWS_SESSION_TOKEN: "FAKE-aws-session-not-real",
});

export interface ConformanceSubject {
  /** Workspace `provider`; its approval modes come from core `RUNTIME_KINDS`. */
  provider: string;
  /** A fresh adapter whose provider entry point is a tripwire; `launches()` counts how often it was reached. */
  tripwire(): { adapter: AgentAdapter; launches(): number };
  /** A run that completes normally. `usage` is the run's counted total the stream must reconcile to. */
  ok?(): { adapter: AgentAdapter; usage?: { input: number; output: number } };
  /** A provider that writes unknown or malformed output and then exits cleanly. */
  malformed?(): AgentAdapter;
  /** A provider that never finishes on its own. */
  hang?(): AgentAdapter;
  /** A provider whose stream ends without a terminal event. */
  noTerminal?(): AgentAdapter;
  /** Relays a deny; resolves true only when the provider side received the deny. */
  relayDeny?(): Promise<boolean>;
  /** Why a scenario cannot be scripted for this provider. */
  unsupported?: Partial<Record<"ok" | "malformed" | "hang" | "noTerminal", string>>;
  describe(): Promise<CapabilityManifest>;
}

export interface SuiteOptions {
  /** `events()` must end within this long after `cancel()`. */
  cancelBoundMs?: number;
  /** Upper bound for any scripted run. */
  runBoundMs?: number;
}

const ALL_MODES: readonly ApprovalMode[] = ["auto-approve", "prompt-on-escalation", "read-only"];

export function spec(mode: ApprovalMode = "auto-approve", prompt = "conformance"): RunSpec {
  return {
    taskId: "AG-conformance" as never,
    prompt,
    workdir: mkdtempSync(join(tmpdir(), "conformance-wd-")),
    permissionPolicy: { mode },
    env: { redactionRules: [], maxRuntimeMs: 10_000 },
  };
}

/** Every event of a run, or a timeout error naming the bound. */
export async function drain(adapter: AgentAdapter, handle: RunHandle, boundMs: number): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`events() did not end within ${boundMs} ms`)), boundMs); });
  try {
    await Promise.race([(async () => { for await (const e of adapter.events(handle)) events.push(e); })(), deadline]);
  } finally {
    clearTimeout(timer);
  }
  return events;
}

const ended = (events: NormalizedEvent[]) => events.filter((e) => e.type === "run.ended");
const okOf = (e: NormalizedEvent | undefined) => (e?.payload as { ok?: unknown } | undefined)?.ok;

async function check(name: string, run: () => Promise<{ status: CheckStatus; detail: string }>): Promise<CheckResult> {
  try {
    return { check: name, ...(await run()) };
  } catch (err) {
    return { check: name, status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Runs every check for one subject. Each check is independent: one failure does not skip the rest. */
export async function runConformance(subject: ConformanceSubject, options: SuiteOptions = {}): Promise<CheckResult[]> {
  const cancelBoundMs = options.cancelBoundMs ?? 3_000;
  const runBoundMs = options.runBoundMs ?? 10_000;
  const kind = runtimeKindFor(subject.provider);
  if (!kind) throw new Error(`no RUNTIME_KINDS row for ${subject.provider}`);
  const results: CheckResult[] = [];
  const skip = (name: string, scenario: keyof NonNullable<ConformanceSubject["unsupported"]>) =>
    results.push({ check: name, status: "unsupported", detail: subject.unsupported?.[scenario] ?? `no scripted ${scenario} scenario` });

  // 1. Unlisted approval modes are refused with NotSupportedError before any provider launch.
  const unlisted = ALL_MODES.filter((m) => !kind.approvalModes.includes(m));
  if (unlisted.length === 0) results.push({ check: "approval-refusal", status: "unsupported", detail: "the adapter enforces every approval mode; nothing to refuse" });
  for (const mode of unlisted) {
    results.push(await check(`approval-refusal:${mode}`, async () => {
      const { adapter, launches } = subject.tripwire();
      let handle: RunHandle | undefined;
      try {
        handle = await adapter.start(spec(mode));
      } catch (err) {
        const named = err instanceof NotSupportedError && err.message.includes(mode);
        if (launches() > 0) return { status: "fail", detail: `the provider was launched ${launches()} time(s) before the refusal` };
        return named
          ? { status: "pass", detail: "NotSupportedError naming the mode, no launch" }
          : { status: "fail", detail: `refused for another reason: ${err instanceof Error ? err.message : String(err)}` };
      }
      await adapter.cancel(handle).catch(() => undefined);
      return { status: "fail", detail: `start() accepted ${mode}; provider launches: ${launches()}` };
    }));
  }

  // 2. Every unit claim in the manifest is listed as proven for this provider; host claims are never proven here.
  const manifest = await withFakeSecrets(() => subject.describe());
  const claims = classifyClaims(subject.provider, manifest);
  results.push(claims.unprovenUnit.length === 0
    ? { check: "claims", status: "pass", detail: `proven: ${claims.provenUnit.join(", ") || "none claimed"}` }
    : { check: "claims", status: "fail", detail: `claimed without conformance evidence: ${claims.unprovenUnit.join(", ")}` });
  results.push(claims.host.length === 0
    ? { check: "host-claims", status: "pass", detail: "no host-level claim" }
    : { check: "host-claims", status: "unsupported", detail: `host evidence required, not provable by a scripted provider: ${claims.host.join(", ")}` });

  // 3. Each listed claim has its check.
  const proven = UNIT_PROVEN_CLAIMS[subject.provider] ?? [];
  if (proven.includes("approvalRelay")) {
    results.push(await check("claim:approvalRelay", async () => {
      if (!subject.relayDeny) return { status: "fail", detail: "approvalRelay is listed as proven but the subject has no relay scenario" };
      return (await subject.relayDeny()) ? { status: "pass", detail: "the relayed deny reached the provider" } : { status: "fail", detail: "the relayed deny did not reach the provider" };
    }));
  }
  const usageClaim = proven.find((c) => c.startsWith("usageAccounting:"));
  if (usageClaim) {
    results.push(await check(`claim:${usageClaim}`, async () => {
      const scripted = subject.ok?.();
      if (!scripted?.usage) return { status: "fail", detail: `${usageClaim} is listed as proven but the subject scripts no usage` };
      const mode = usageClaim.split(":")[1] as "cumulative" | "delta";
      const handle = await scripted.adapter.start(spec());
      const events = await drain(scripted.adapter, handle, runBoundMs);
      const counted = accumulateInRun(mode, events.filter((e) => e.type === "usage.updated").map((e) => e.payload as { inputTokens?: number; outputTokens?: number }));
      return counted.input === scripted.usage.input && counted.output === scripted.usage.output
        ? { status: "pass", detail: `counted ${counted.input}/${counted.output}` }
        : { status: "fail", detail: `counted ${counted.input}/${counted.output}, provider total ${scripted.usage.input}/${scripted.usage.output}` };
    }));
  }

  // 4. Completion: a normal run ends exactly once, last, with ok: true; a stream with no terminal event is never a success.
  if (subject.ok) {
    results.push(await check("completion", async () => {
      const { adapter } = subject.ok!();
      const events = await drain(adapter, await adapter.start(spec()), runBoundMs);
      const ends = ended(events);
      if (ends.length !== 1) return { status: "fail", detail: `${ends.length} run.ended events` };
      if (events.at(-1)?.type !== "run.ended") return { status: "fail", detail: `last event is ${events.at(-1)?.type}` };
      return okOf(ends[0]) === true ? { status: "pass", detail: "one run.ended, last, ok" } : { status: "fail", detail: "a completed script did not end ok" };
    }));
  } else skip("completion", "ok");
  if (subject.noTerminal) {
    results.push(await check("completion:no-terminal", async () => {
      const adapter = subject.noTerminal!();
      const events = await drain(adapter, await adapter.start(spec()), runBoundMs);
      const ends = ended(events);
      if (ends.length !== 1 || events.at(-1)?.type !== "run.ended") return { status: "fail", detail: `run.ended count ${ends.length}, last ${events.at(-1)?.type}` };
      return okOf(ends[0]) === false ? { status: "pass", detail: "ended, not ok" } : { status: "fail", detail: "a stream with no terminal event ended as a success" };
    }));
  } else skip("completion:no-terminal", "noTerminal");

  // 5. Malformed output fails explicitly and fabricates nothing.
  if (subject.malformed) {
    results.push(await check("malformed-output", async () => {
      const adapter = subject.malformed!();
      const events = await drain(adapter, await adapter.start(spec()), runBoundMs);
      const fabricated = events.filter((e) => !["run.started", "error", "run.ended"].includes(e.type));
      if (fabricated.length > 0) return { status: "fail", detail: `fabricated ${fabricated.map((e) => e.type).join(", ")}` };
      const last = events.at(-1);
      if (last?.type !== "run.ended" || okOf(last) !== false) return { status: "fail", detail: "malformed output did not end the run as failed" };
      return { status: "pass", detail: "only error/run.ended, not ok" };
    }));
  } else skip("malformed-output", "malformed");

  // 6. cancel() ends the run and closes events() within the bound.
  if (subject.hang) {
    results.push(await check("cancel", async () => {
      const adapter = subject.hang!();
      const handle = await adapter.start(spec());
      const collected = drain(adapter, handle, cancelBoundMs + runBoundMs);
      await new Promise((r) => setTimeout(r, 100));
      const t0 = Date.now();
      await adapter.cancel(handle);
      const events = await Promise.race([collected, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`events() still open ${cancelBoundMs} ms after cancel()`)), cancelBoundMs))]);
      const ms = Date.now() - t0;
      const last = events.at(-1);
      if (last?.type !== "run.ended" || okOf(last) !== false) return { status: "fail", detail: `last event after cancel: ${last?.type}` };
      return { status: "pass", detail: `closed ${ms} ms after cancel()` };
    }));
  } else skip("cancel", "hang");

  // 7. No credential value in the manifest.
  const json = JSON.stringify(manifest);
  const leaked = Object.entries(FAKE_SECRETS).filter(([, value]) => json.includes(value)).map(([name]) => name);
  results.push(leaked.length === 0 ? { check: "redaction", status: "pass", detail: "no secret value in the manifest" } : { check: "redaction", status: "fail", detail: `manifest carries ${leaked.join(", ")}` });

  return results;
}

/** Runs `fn` with the FAKE secret values in the environment, restoring the previous values after. */
export async function withFakeSecrets<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(FAKE_SECRETS).map((k) => [k, process.env[k]]));
  Object.assign(process.env, FAKE_SECRETS);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A path inside a fresh directory that holds nothing: a provider launch through it cannot start. */
export function missingBinary(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "conformance-tripwire-")), name);
}

export const exists = existsSync;
