/**
 * The runtime conformance probe behind `POST /api/assistants/:id/test` (Agent Runtime Registry
 * design §B.3–B.4 and PR 4; docs/contracts/agent-runtime-v1.md).
 *
 * Every check is credential-free and quota-free BY CONSTRUCTION:
 *
 * - `executable` runs `<cli> --version` only, with a bounded timeout. It is the same call the
 *   capability probe already makes at boot and daily.
 * - `approval-refusal:<mode>` builds the runtime's real adapter class with its provider entry point
 *   pointed at a binary that cannot exist (or, for Bedrock, with no runtime ARN), so a missed
 *   refusal can only fail to start: it can never reach a model.
 * - `manifest-claims`, `host-claims` and `manifest-redaction` read the STORED manifest. They do not
 *   call `describe()`.
 * - `in-process-run` runs the in-process fake only.
 * - `self-description` is never executed: no CLI self-description is proven here to stop before a
 *   model request, so it is reported `not-run` with the reason.
 *
 * Nothing here calls the registered adapter, starts a generation, installs a runtime, changes a
 * credential or writes config. The result is version-bound: one `runtime_conformance` row keyed by
 * the CLI version observed now and the descriptor version. Only classified outcomes are stored or
 * returned; never stdout, stderr or a provider transcript.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyClaims } from "@agent-plane/adapters";
import { NotSupportedError, type AgentAdapter, type ApprovalMode, type AssistantId, type CapabilityManifest, type NormalizedEvent, type RunSpec } from "@agent-plane/core";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { INLINE_SECRET } from "../registry-contract.js";
import { probeCommand } from "./capability-probe.js";
import type { AssistantRow, Registry } from "./registry.js";
import { runtimeFor, type RuntimeDescriptor } from "./runtime-catalog.js";
import { AGENT_RUNTIME_SCHEMA_VERSION, RuntimeLifecycleReader, type AssistantLifecycle } from "./runtime-lifecycle.js";

export const CHECK_STATUSES = ["pass", "fail", "unsupported", "unavailable", "not-run"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
/** What a check's result is evidence about: this build's adapter code, this host, or the provider CLI. */
export type EvidenceLevel = "build" | "host" | "provider";

/** Every classified reason a check or result can carry. Fixed vocabulary: never free text. */
export const CONFORMANCE_REASONS = [
  "version_reported", "executable_missing", "executable_not_runnable", "nonzero_exit", "empty_version", "unsafe_version_output", "timeout", "in_process_runtime",
  "refused_before_launch", "refused_for_other_reason", "not_refused", "launch_attempted", "no_tripwire", "all_modes_enforced",
  "claims_backed", "unproven_claim", "no_manifest", "no_host_claim", "host_probe_not_authorized",
  "no_secret_in_manifest", "secret_in_manifest",
  "quota_free_unverified", "no_self_description",
  "scripted_run_completed", "scripted_run_incomplete", "not_in_process",
] as const;
export type ConformanceReason = (typeof CONFORMANCE_REASONS)[number];

export interface ConformanceCheck { name: string; status: CheckStatus; level: EvidenceLevel; reason: ConformanceReason }

export interface ConformanceResult {
  schemaVersion: string;
  assistantId: string;
  provider: string;
  descriptorVersion: number;
  /** The version observed by this test (`in-process` for an in-process runtime, `unavailable` when the CLI did not run). Absent when it was unsafe to repeat. */
  cliVersion?: string;
  /** `pass`: no check failed or was unavailable, no claim is unproven, and at least one check passed. `unsupported`: nothing could be checked. */
  status: "pass" | "fail" | "unsupported";
  /** Classified reasons for a `fail`, in check order. Empty otherwise. */
  reasons: ConformanceReason[];
  /** Whether a `runtime_conformance` row was written (never for `unsupported` or an unsafe version). */
  recorded: boolean;
  checkedAt: string;
  checks: ConformanceCheck[];
  lifecycle: AssistantLifecycle;
}

export type VersionOutcome =
  | { kind: "ok"; version: string }
  | { kind: "missing" | "not-runnable" | "timeout" | "nonzero" | "empty" };

/** `<command> --version`, bounded. The only process this module ever starts. */
export function runVersion(command: string, timeoutMs: number): Promise<VersionOutcome> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, env: process.env }, (err, stdout) => {
      if (!err) {
        const version = stdout.trim();
        return resolve(version ? { kind: "ok", version } : { kind: "empty" });
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      if (e.code === "ENOENT") return resolve({ kind: "missing" });
      if (e.code === "EACCES" || e.code === "ENOEXEC") return resolve({ kind: "not-runnable" });
      if (e.killed || e.signal === "SIGKILL") return resolve({ kind: "timeout" });
      return resolve({ kind: "nonzero" });
    });
  });
}

export interface RuntimeConformanceOptions {
  /** Bound for `--version` (default 5 s). */
  versionTimeoutMs?: number;
  /** Bound for each refusal check and the in-process run (default 2 s). */
  checkTimeoutMs?: number;
  /** Test seam for the `--version` call. */
  versionOf?: (command: string, timeoutMs: number) => Promise<VersionOutcome>;
}

export class ConformanceBusyError extends Error {
  constructor(id: string) { super(`a conformance test for ${id} is already running`); this.name = "ConformanceBusyError"; }
}

const ALL_MODES: readonly ApprovalMode[] = ["auto-approve", "prompt-on-escalation", "read-only"];
/** A CLI version the plane will repeat or key evidence by: short, printable, nothing credential-shaped. */
const safeVersion = (v: string) => v.length <= 128 && [...v].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f) && !INLINE_SECRET.test(v);
/** Environment names whose values must never appear in a manifest. Values are compared, never read out. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), ms); })]).finally(() => clearTimeout(timer));
}

export class RuntimeConformance {
  private running = new Set<string>();
  private readonly versionTimeoutMs: number;
  private readonly checkTimeoutMs: number;
  private readonly versionOf: (command: string, timeoutMs: number) => Promise<VersionOutcome>;

  constructor(
    private db: Db,
    private config: ResolvedConfig,
    private registry: Pick<Registry, "get">,
    private now: () => Date = () => new Date(),
    options: RuntimeConformanceOptions = {},
  ) {
    this.versionTimeoutMs = options.versionTimeoutMs ?? 5_000;
    this.checkTimeoutMs = options.checkTimeoutMs ?? 2_000;
    this.versionOf = options.versionOf ?? runVersion;
  }

  /**
   * Runs the checks for one configured assistant and records the version-bound result.
   * `undefined` for an id the registry has no row for. Throws `ConformanceBusyError` while a test
   * for the same assistant is running, and an Error when the assistant is no longer configured.
   */
  async test(id: string): Promise<ConformanceResult | undefined> {
    const row = this.registry.get(id);
    if (!row) return undefined;
    const configured = this.config.assistants[id];
    if (!configured) throw new Error(`assistant ${id} is not in the workspace config`);
    const descriptor = runtimeFor(row.provider);
    if (!descriptor) throw new Error(`assistant ${id} has no runtime descriptor for provider ${row.provider}`);
    if (this.running.has(id)) throw new ConformanceBusyError(id);
    this.running.add(id);
    try {
      return await this.run(row, descriptor, configured.options ?? {});
    } finally {
      this.running.delete(id);
    }
  }

  private async run(row: AssistantRow & { manifestParsed: CapabilityManifest | null }, descriptor: RuntimeDescriptor, options: Record<string, unknown>): Promise<ConformanceResult> {
    const checks: ConformanceCheck[] = [];
    const add = (name: string, status: CheckStatus, level: EvidenceLevel, reason: ConformanceReason) => checks.push({ name, status, level, reason });

    // 1. The executable, by `--version` only.
    let cliVersion: string | undefined;
    let versionSafe = true;
    const command = descriptor.probe ? probeCommand(descriptor.probe, options) : undefined;
    if (!command) {
      cliVersion = "in-process";
      add("executable", "unsupported", "host", "in_process_runtime");
    } else {
      const outcome = await this.versionOf(command, this.versionTimeoutMs);
      if (outcome.kind === "ok") {
        if (safeVersion(outcome.version)) { cliVersion = outcome.version; add("executable", "pass", "host", "version_reported"); }
        else { versionSafe = false; add("executable", "fail", "host", "unsafe_version_output"); }
      } else {
        // Keyed exactly as the capability probe records a CLI that did not run.
        cliVersion = "unavailable";
        const map = { missing: ["unavailable", "executable_missing"], "not-runnable": ["unavailable", "executable_not_runnable"], timeout: ["fail", "timeout"], nonzero: ["fail", "nonzero_exit"], empty: ["fail", "empty_version"] } as const;
        const [status, reason] = map[outcome.kind];
        add("executable", status, "host", reason);
      }
    }

    // 2. Approval modes outside the descriptor's list are refused before any launch.
    const unlisted = ALL_MODES.filter((m) => !descriptor.approvalModes.includes(m));
    if (unlisted.length === 0) add("approval-refusal", "unsupported", "build", "all_modes_enforced");
    for (const mode of unlisted) {
      const refusal = descriptor.conformance.refusalAdapter;
      if (!refusal) { add(`approval-refusal:${mode}`, "unsupported", "build", "no_tripwire"); continue; }
      const [status, reason] = await this.refusal(refusal, row.id as AssistantId, options, mode);
      add(`approval-refusal:${mode}`, status, "build", reason);
    }

    // 3. Claims in the stored manifest: unit claims need conformance-suite evidence, host claims need host evidence.
    const manifest = row.manifestParsed;
    let hostClaimUnproven = false;
    if (!manifest) {
      add("manifest-claims", "not-run", "build", "no_manifest");
      add("host-claims", "not-run", "host", "no_manifest");
      add("manifest-redaction", "not-run", "host", "no_manifest");
    } else {
      const claims = classifyClaims(row.provider, manifest);
      add("manifest-claims", claims.unprovenUnit.length === 0 ? "pass" : "fail", "build", claims.unprovenUnit.length === 0 ? "claims_backed" : "unproven_claim");
      if (claims.host.length === 0) add("host-claims", "pass", "host", "no_host_claim");
      else { hostClaimUnproven = true; add("host-claims", "not-run", "host", "host_probe_not_authorized"); }
      add("manifest-redaction", ...this.redaction(manifest));
    }

    // 4. Self-description: never executed until it is proven quota-free.
    if (descriptor.conformance.selfDescription) add("self-description", "not-run", "provider", descriptor.conformance.selfDescription.reason);
    else add("self-description", "unsupported", "provider", "no_self_description");

    // 5. In-process runtimes: a scripted run (quota-free by construction).
    if (descriptor.conformance.inProcessRun) {
      const ok = await this.inProcessRun(descriptor, row.id as AssistantId, options);
      add("in-process-run", ok ? "pass" : "fail", "build", ok ? "scripted_run_completed" : "scripted_run_incomplete");
    }

    const reasons: ConformanceReason[] = checks.filter((c) => c.status === "fail" || c.status === "unavailable").map((c) => c.reason);
    if (hostClaimUnproven) reasons.push("host_probe_not_authorized");
    if (!manifest) reasons.push("no_manifest");
    const status: ConformanceResult["status"] = reasons.length > 0 ? "fail" : checks.some((c) => c.status === "pass") ? "pass" : "unsupported";
    const checkedAt = this.now().toISOString();
    const recorded = status !== "unsupported" && versionSafe && cliVersion !== undefined;
    if (recorded) {
      this.db.prepare(`INSERT INTO runtime_conformance (assistant_id, cli_version, descriptor_version, status, checks, checked_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(assistant_id, cli_version, descriptor_version) DO UPDATE SET status = excluded.status, checks = excluded.checks, checked_at = excluded.checked_at`)
        .run(row.id, cliVersion, descriptor.descriptorVersion, status, JSON.stringify(checks), checkedAt);
    }
    return {
      schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
      assistantId: row.id,
      provider: row.provider,
      descriptorVersion: descriptor.descriptorVersion,
      ...(cliVersion !== undefined && versionSafe ? { cliVersion } : {}),
      status,
      reasons: [...new Set(reasons)],
      recorded,
      checkedAt,
      checks,
      lifecycle: new RuntimeLifecycleReader(this.db, this.config).of(this.registry.get(row.id)!),
    };
  }

  private async refusal(
    build: NonNullable<RuntimeDescriptor["conformance"]["refusalAdapter"]>, id: AssistantId, options: Record<string, unknown>, mode: ApprovalMode,
  ): Promise<[CheckStatus, ConformanceReason]> {
    const dir = mkdtempSync(join(tmpdir(), "aos-conformance-"));
    try {
      const adapter = build(id, options, join(dir, "absent-provider"));
      const attempt = adapter.start(this.spec(mode, dir)).then(
        async (handle) => { await adapter.cancel(handle).catch(() => undefined); return "accepted" as const; },
        (err: unknown) => (err instanceof NotSupportedError && err.message.includes(mode) ? "refused" as const : "other" as const),
      );
      const outcome = await withTimeout(attempt, this.checkTimeoutMs);
      if (outcome === "refused") return ["pass", "refused_before_launch"];
      if (outcome === "other") return ["fail", "refused_for_other_reason"];
      if (outcome === "accepted") return ["fail", "not_refused"];
      return ["fail", "timeout"];
    } catch {
      return ["fail", "refused_for_other_reason"];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private redaction(manifest: CapabilityManifest): [CheckStatus, EvidenceLevel, ConformanceReason] {
    const json = JSON.stringify(manifest);
    const leaked = INLINE_SECRET.test(json) || Object.entries(process.env).some(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8 && json.includes(value));
    return leaked ? ["fail", "host", "secret_in_manifest"] : ["pass", "host", "no_secret_in_manifest"];
  }

  private async inProcessRun(descriptor: RuntimeDescriptor, id: AssistantId, options: Record<string, unknown>): Promise<boolean> {
    const dir = mkdtempSync(join(tmpdir(), "aos-conformance-"));
    try {
      const adapter: AgentAdapter = descriptor.create({ sessionInputEnabled: false }, id, options);
      const handle = await adapter.start(this.spec("auto-approve", dir));
      const events: NormalizedEvent[] = [];
      const drained = (async () => { for await (const e of adapter.events(handle)) events.push(e); })();
      if ((await withTimeout(drained, this.checkTimeoutMs)) === "timeout") { await adapter.cancel(handle).catch(() => undefined); return false; }
      const ends = events.filter((e) => e.type === "run.ended");
      return ends.length === 1 && events.at(-1)?.type === "run.ended" && (ends[0]!.payload as { ok?: unknown } | undefined)?.ok === true;
    } catch {
      return false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private spec(mode: ApprovalMode, workdir: string): RunSpec {
    return {
      taskId: "AG-conformance-probe" as never,
      prompt: "conformance probe",
      workdir,
      permissionPolicy: { mode },
      env: { redactionRules: [], maxRuntimeMs: this.checkTimeoutMs },
    };
  }
}
