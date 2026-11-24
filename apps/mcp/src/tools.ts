import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig } from "./config.js";
import type { Contract, ToolName } from "./contract.js";
import { PlaneError, PlaneUnavailable, type PlaneClient, type PlaneResponse, type PlaneTaskDetail } from "./plane.js";
import type { RateLimiter } from "./ratelimit.js";

/**
 * The four mcp-tools/v1 tools as projections of plane reads and commands. The MCP process derives
 * no stage, route or link of its own: it filters to exposed repos, renames fields and maps refusals.
 */
type ErrorCode =
  | "invalid_input" | "repo_not_allowed" | "not_found" | "idempotency_conflict" | "idempotency_in_progress"
  | "invalid_state" | "route_changed" | "no_eligible_assistant" | "rate_limited" | "plane_unavailable" | "internal";

export class ToolError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly retryable = false, readonly extra: Record<string, unknown> = {}) { super(message); }
}

export interface ToolContext { grantId: string }

export interface ToolDeps {
  config: Pick<McpConfig, "repos" | "rateLimits">;
  contract: Contract;
  plane: PlaneClient;
  limiter: RateLimiter;
  /** Published by the plane (`GET /api/workspace` → mcp.webOrigin); checked at boot. */
  webOrigin: string;
}

const TASK_ID = /^AG-[0-9a-z]{1,32}$/;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class Tools {
  private readonly aliasOfPath: Map<string, string>;
  constructor(private readonly deps: ToolDeps) {
    this.aliasOfPath = new Map(Object.entries(deps.config.repos).map(([alias, path]) => [path, alias]));
  }

  private link(taskId: string) { return `${this.deps.webOrigin}/#/missions/${taskId}`; }

  async call(name: string, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
    const { contract } = this.deps;
    if (!(name in contract.scopeOf)) return this.error(new ToolError("invalid_input", `unknown tool ${cut(name, 64)}`));
    const tool = name as ToolName;
    const input = (args ?? {}) as Record<string, unknown>;
    if (!contract.validateInput[tool](input)) {
      const first = contract.validateInput[tool].errors?.[0];
      return this.error(new ToolError("invalid_input", cut(`invalid arguments: ${first?.instancePath || "/"} ${first?.message ?? ""}`.trim(), 500)));
    }
    try {
      this.limit(tool, ctx);
      const out = await this.run(tool, input);
      if (!contract.validateOutput[tool](out)) {
        // Fail closed: a plane answer that does not fit the contract is not passed on.
        throw new ToolError("internal", "the plane's answer did not match the tool contract");
      }
      return { content: [{ type: "text", text: summarize(tool, out) }], structuredContent: out };
    } catch (err) {
      return this.error(err);
    }
  }

  private limit(tool: ToolName, ctx: ToolContext) {
    const l = this.deps.config.rateLimits;
    const [kind, limit, windowMs] = tool === "create_task" ? ["create", l.createsPerHour, 3_600_000]
      : tool === "start_task" ? ["start", l.startsPerHour, 3_600_000] : ["read", l.readsPerMinute, 60_000];
    const r = this.deps.limiter.hit(
      { key: `grant:${ctx.grantId}:${kind}`, limit: limit as number, windowMs: windowMs as number },
      { key: `instance:${kind}`, limit: (limit as number) * l.instanceFactor, windowMs: windowMs as number },
    );
    if (!r.ok) throw new ToolError("rate_limited", `too many ${kind} calls; retry later`, true, { retryAfterSeconds: r.retryAfterSeconds });
  }

  private error(err: unknown): CallToolResult {
    const e = err instanceof ToolError ? err
      : err instanceof PlaneUnavailable ? new ToolError("plane_unavailable", "the Agent OS host did not answer", true)
      : err instanceof PlaneError ? fromPlane(err.response)
      : new ToolError("internal", "internal error");
    const structured = { code: e.code, message: cut(e.message, 500), retryable: e.retryable, ...e.extra };
    const valid = this.deps.contract.validateError(structured);
    const body = valid ? structured : { code: "internal", message: "internal error", retryable: false };
    // The tool-error object travels as JSON in a second text block, not as structuredContent: MCP SDK
    // clients (TypeScript SDK 1.32.2 included) validate any structuredContent against the tool's
    // outputSchema even when isError is true, so an error object there is rejected client-side.
    return { isError: true, content: [{ type: "text", text: `${body.code}: ${body.message}` }, { type: "text", text: JSON.stringify(body) }] };
  }

  private run(tool: ToolName, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (tool) {
      case "list_tasks": return this.listTasks(input);
      case "get_task": return this.getTask(input.taskId as string);
      case "create_task": return this.createTask(input);
      case "start_task": return this.startTask(input);
    }
  }

  private requireAlias(alias: unknown): string {
    if (typeof alias !== "string" || !Object.hasOwn(this.deps.config.repos, alias)) {
      throw new ToolError("repo_not_allowed", "repo is not an exposed repository alias");
    }
    return alias;
  }

  private async listTasks(input: Record<string, unknown>) {
    if (input.repo !== undefined) this.requireAlias(input.repo);
    const limit = (input.limit as number | undefined) ?? 20;
    const matching = (await this.deps.plane.listTasks())
      .flatMap((t) => {
        const alias = t.repoPath ? this.aliasOfPath.get(t.repoPath) : undefined;
        return alias && t.stage ? [{ t, alias, stage: t.stage }] : [];
      })
      .filter(({ alias, stage }) => (input.repo === undefined || alias === input.repo) && (input.stage === undefined || stage.value === input.stage))
      .sort((a, b) => (a.t.updatedAt < b.t.updatedAt ? 1 : a.t.updatedAt > b.t.updatedAt ? -1 : 0));
    return {
      tasks: matching.slice(0, limit).map(({ t, alias, stage }) => ({
        taskId: t.id, goal: cut(t.goal, 200), state: t.state, stage: { value: stage.value, rule: stage.rule },
        repo: alias, webLink: this.link(t.id), updatedAt: t.updatedAt,
      })),
      truncated: matching.length > limit,
    };
  }

  /** The task when it exists and is in an exposed repo; otherwise not_found, same as an unknown id (T5). */
  private async exposedTask(taskId: string): Promise<{ detail: PlaneTaskDetail; alias: string }> {
    if (!TASK_ID.test(taskId)) throw new ToolError("not_found", "no such task");
    const res = await this.deps.plane.getTask(taskId);
    if (res.status === 404) throw new ToolError("not_found", "no such task");
    if (res.status !== 200) throw new PlaneError(res);
    const detail = res.body as unknown as PlaneTaskDetail;
    const alias = detail.repo_path ? this.aliasOfPath.get(detail.repo_path) : undefined;
    if (!alias) throw new ToolError("not_found", "no such task");
    return { detail, alias };
  }

  private async getTask(taskId: string) {
    const { detail, alias } = await this.exposedTask(taskId);
    // One plane read (API 2.17) carries the stage, the approval count and the verification summary,
    // so the three always describe the same moment. The MCP process recomputes none of them.
    if (!detail.stage) throw new ToolError("internal", "the plane published no stage for this task");
    if (!Number.isInteger(detail.pendingApprovals)) throw new ToolError("internal", "the plane published no approval count for this task");
    if (detail.verification === undefined) throw new ToolError("internal", "the plane published no verification field for this task");
    const run = detail.runs.at(-1);
    const v = detail.verification;
    return {
      taskId: detail.id, goal: cut(detail.goal, 4000), state: detail.state, stage: { value: detail.stage.value, rule: detail.stage.rule },
      repo: alias, webLink: detail.webLink ?? this.link(detail.id), createdAt: detail.created_at, updatedAt: detail.updated_at,
      pendingApprovals: detail.pendingApprovals,
      latestRun: run ? { runId: run.id, assistantId: run.assistant_id, state: run.state, startedAt: run.started_at, endedAt: run.ended_at } : null,
      verification: v ? { runState: v.runState, checks: { passed: v.checks.passed, failed: v.checks.failed, skipped: v.checks.skipped, blocked: v.checks.blocked } } : null,
    };
  }

  private async createTask(input: Record<string, unknown>) {
    const repo = this.requireAlias(input.repo);
    const body: Record<string, unknown> = { goal: input.goal, repo, idempotencyKey: input.idempotencyKey, propose: true };
    if (input.constraints !== undefined) body.constraints = input.constraints;
    if (input.profile !== undefined) body.profile = input.profile;
    const res = await this.deps.plane.createTask(body);
    if (res.status !== 201) throw new PlaneError(res);
    const taskId = String(res.body.taskId);
    if (res.body.repo !== repo) throw new ToolError("internal", "the plane resolved a different repository alias");
    // The plane's create answer has no createdAt; read it (same credential, tasks.read).
    const read = await this.deps.plane.getTask(taskId);
    if (read.status !== 200) throw new PlaneError(read);
    return {
      taskId, state: "CREATED", repo, webLink: res.body.webLink ?? this.link(taskId),
      proposal: res.body.proposal, replayed: res.body.replayed === true, createdAt: (read.body as unknown as PlaneTaskDetail).created_at,
    };
  }

  private async startTask(input: Record<string, unknown>) {
    const taskId = input.taskId as string;
    // Out-of-scope tasks are refused before any plane write (T4, T5).
    await this.exposedTask(taskId);
    const body: Record<string, unknown> = { idempotencyKey: input.idempotencyKey };
    if (input.confirm !== undefined) body.confirm = input.confirm;
    const res = await this.deps.plane.startTask(taskId, body);
    if (res.status !== 200) throw new PlaneError(res);
    const b = res.body;
    return {
      taskId, state: b.state, runId: b.runId ?? null, assistantId: b.assistantId, webLink: b.webLink ?? this.link(taskId),
      replayed: b.replayed === true, startedAt: b.startedAt,
    };
  }
}

/** Plane refusal → tool error. The plane's free-text `error` is not passed on (it may carry paths). */
export function fromPlane(res: PlaneResponse): ToolError {
  const reason = typeof res.body.reason === "string" ? res.body.reason : undefined;
  switch (reason) {
    case "idempotency_conflict": return new ToolError("idempotency_conflict", "this idempotencyKey was already used with different input");
    case "idempotency_in_progress": return new ToolError("idempotency_in_progress", "a request with this idempotencyKey is still being handled; retry", true);
    case "invalid_state": return new ToolError("invalid_state", "only a CREATED task can start", false,
      typeof res.body.currentState === "string" ? { currentState: res.body.currentState } : {});
    case "route_changed": return new ToolError("route_changed", "the route changed since it was proposed; nothing started. Review the new proposal.", false, { proposal: res.body.proposal });
    case "no_eligible_assistant": return new ToolError("no_eligible_assistant", "no assistant is eligible for this task right now", true);
    case "repo_not_allowed": return new ToolError("repo_not_allowed", "repo is not an exposed repository alias");
    case "invalid_input": return new ToolError("invalid_input", "the plane refused the arguments");
  }
  if (res.status === 404) return new ToolError("not_found", "no such task");
  if (res.status >= 500) return new ToolError("plane_unavailable", "the Agent OS host failed to handle the request", true);
  if (res.status === 400) return new ToolError("invalid_input", "the plane refused the arguments");
  return new ToolError("internal", "the plane refused this service's credential or request");
}

function summarize(tool: ToolName, out: Record<string, unknown>): string {
  switch (tool) {
    case "list_tasks": {
      const tasks = out.tasks as Array<{ taskId: string; stage: { value: string }; goal: string; webLink: string }>;
      if (tasks.length === 0) return "No tasks in the exposed repositories.";
      return tasks.map((t) => `${t.taskId} [${t.stage.value}] ${t.goal} ${t.webLink}`).join("\n") + (out.truncated ? "\n(more tasks exist)" : "");
    }
    case "get_task": {
      const s = out.stage as { value: string };
      const n = out.pendingApprovals as number;
      const v = out.verification as { runState: string; checks: Record<string, number> } | null;
      const approvals = n > 0 ? ` ${n} approval${n === 1 ? "" : "s"} waiting.` : "";
      const checks = v ? ` Verification ${v.runState}: ${v.checks.passed} passed, ${v.checks.failed} failed, ${v.checks.skipped} skipped, ${v.checks.blocked} blocked.` : "";
      return `${String(out.taskId)} is ${String(out.state)} (${s.value}).${approvals}${checks} Open ${String(out.webLink)} to follow it or answer approvals.`;
    }
    case "create_task": {
      const p = out.proposal as { eligible: boolean; summary: string };
      return `Created ${String(out.taskId)} in ${String(out.repo)} (not started${out.replayed ? ", replayed" : ""}). ${p.summary} Web: ${String(out.webLink)}`;
    }
    case "start_task":
      return `Started ${String(out.taskId)} on ${String(out.assistantId)}${out.replayed ? " (replayed)" : ""}. Follow it at ${String(out.webLink)}`;
  }
}
