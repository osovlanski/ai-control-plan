import {
  evaluationResult,
  redactText,
  type EvaluationResult,
  type ExecutionArtifact,
  type VerificationCheckResult,
  type VerificationKind,
  type VerificationSpec,
} from "@agent-plane/core";
import type { WorkspaceAuthority } from "./workspace-authority.js";

export interface VerificationProviderContext {
  authority?: WorkspaceAuthority;
  worktreePath?: string;
  remainingMs(): number;
}

export interface VerificationProvider {
  readonly id: string;
  supports(spec: VerificationSpec): boolean;
  run(spec: VerificationSpec, context: VerificationProviderContext): Promise<VerificationProviderOutcome>;
}

export interface VerificationProviderOutcome {
  status: VerificationCheckResult["status"];
  summary: string;
  ref?: string;
  artifacts?: ExecutionArtifact[];
}

export interface VerificationRunResult {
  evaluation: EvaluationResult;
  artifacts: ExecutionArtifact[];
}

function outcome(
  status: VerificationCheckResult["status"],
  summary: string,
): VerificationProviderOutcome {
  return { status, summary };
}

function checkResult(spec: VerificationSpec, provider: VerificationProviderOutcome): VerificationCheckResult {
  return {
    ...(spec.checkId ? { checkId: spec.checkId } : {}),
    name: spec.name,
    kind: spec.kind,
    passed: provider.status === "passed",
    status: provider.status,
    required: spec.required,
    summary: redactText(provider.summary).slice(0, 2000),
    ...(provider.ref ? { ref: redactText(provider.ref).slice(0, 2000) } : {}),
  } as VerificationCheckResult;
}

function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactText(raw).slice(0, 2000);
}

const ARTIFACT_KINDS = new Set<ExecutionArtifact["kind"]>([
  "diff", "file_list", "test_report", "checkpoint", "rendered_output",
  "api_report", "browser_report", "screenshot", "console_log",
  "evaluation_report", "review_report", "trace_ref",
]);
const RETENTIONS = new Set<NonNullable<ExecutionArtifact["retention"]>>([
  "ephemeral", "session", "task", "pinned",
]);

function normalizeArtifact(value: unknown): ExecutionArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const artifact = value as Record<string, unknown>;
  if (!ARTIFACT_KINDS.has(artifact.kind as ExecutionArtifact["kind"]) ||
      typeof artifact.ref !== "string" || typeof artifact.summary !== "string") return undefined;
  const normalized: ExecutionArtifact = {
    kind: artifact.kind as ExecutionArtifact["kind"],
    ref: redactText(artifact.ref).slice(0, 2000),
    summary: redactText(artifact.summary).slice(0, 2000),
  };
  if (typeof artifact.digest === "string") normalized.digest = redactText(artifact.digest).slice(0, 2000);
  if (typeof artifact.mediaType === "string") normalized.mediaType = redactText(artifact.mediaType).slice(0, 200);
  if (typeof artifact.sizeBytes === "number" && Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0) {
    normalized.sizeBytes = artifact.sizeBytes;
  }
  if (RETENTIONS.has(artifact.retention as NonNullable<ExecutionArtifact["retention"]>)) {
    normalized.retention = artifact.retention as NonNullable<ExecutionArtifact["retention"]>;
  }
  return normalized;
}

export class ArtifactExistsVerifier implements VerificationProvider {
  readonly id = "artifact-exists";
  supports(spec: VerificationSpec): boolean {
    return spec.kind === "artifact_exists" &&
      (spec.provider === undefined || spec.provider === "native" || spec.provider === this.id);
  }
  async run(spec: VerificationSpec, context: VerificationProviderContext): Promise<VerificationProviderOutcome> {
    if (!context.authority || !context.worktreePath) return outcome("skipped", "skipped (no workspace authority)");
    if (!spec.command) return outcome("skipped", "skipped (no artifact path)");
    try {
      const exists = context.authority.artifactExists(context.worktreePath, spec.command);
      return outcome(exists ? "passed" : "failed", `artifact ${spec.command} ${exists ? "exists" : "missing"}`);
    } catch (err) {
      return outcome("blocked", `artifact path rejected: ${safeMessage(err)}`);
    }
  }
}

const COMMAND_KINDS = new Set<VerificationKind>(["tests", "typecheck", "lint", "command", "evaluator"]);

export class CommandVerifier implements VerificationProvider {
  readonly id = "command";
  supports(spec: VerificationSpec): boolean {
    return COMMAND_KINDS.has(spec.kind) &&
      (spec.provider === undefined || spec.provider === "native" || spec.provider === "command");
  }
  async run(spec: VerificationSpec, context: VerificationProviderContext): Promise<VerificationProviderOutcome> {
    if (!context.authority || !context.worktreePath) return outcome("skipped", "skipped (no workspace authority)");
    if (!spec.command) return outcome("skipped", "skipped (no command)");
    try {
      const command = await context.authority.runCommand({
        command: spec.command,
        worktreePath: context.worktreePath,
        timeoutMs: context.remainingMs(),
      });
      const passed = command.exitCode === 0 && !command.timedOut;
      return outcome(
        passed ? "passed" : "failed",
        `${spec.command} → exit ${command.exitCode}${command.timedOut ? " (timed out)" : ""}`,
      );
    } catch (err) {
      return outcome("blocked", `command rejected: ${safeMessage(err)}`);
    }
  }
}

export class VerificationProviderRegistry {
  constructor(private readonly providers: readonly VerificationProvider[]) {}

  async run(specs: readonly VerificationSpec[], context: VerificationProviderContext): Promise<VerificationRunResult | undefined> {
    if (specs.length === 0) return undefined;
    const checks: VerificationCheckResult[] = [];
    const artifacts: ExecutionArtifact[] = [];
    for (const spec of specs) {
      try {
        const provider = this.providers.find((candidate) => candidate.supports(spec));
        const providerOutcome = provider
          ? await provider.run(spec, context)
          : outcome("blocked", `blocked (no verifier provider for ${spec.kind})`);
        checks.push(checkResult(spec, providerOutcome));
        for (const artifact of providerOutcome.artifacts ?? []) {
          const normalized = normalizeArtifact(artifact);
          if (normalized) artifacts.push(normalized);
        }
      } catch (err) {
        checks.push(checkResult(spec, outcome("blocked", `verifier provider failed: ${safeMessage(err)}`)));
      }
    }
    return { evaluation: evaluationResult(checks), artifacts };
  }
}

export const DEFAULT_VERIFICATION_PROVIDERS = new VerificationProviderRegistry([
  new ArtifactExistsVerifier(),
  new CommandVerifier(),
]);
