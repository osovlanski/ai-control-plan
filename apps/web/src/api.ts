export interface Workspace {
  workspace: string;
  assistants: string[];
  repoAllowlist: string[];
  failover: { auto: boolean; softThresholdPct: number; triggers: string[] };
}

export interface Assistant {
  id: string;
  provider: string;
  enabled: boolean;
  manifestUpdatedAt: string | null;
  manifest: {
    core: {
      models: { id: string; displayName?: string }[];
      canResume: boolean;
      canMcp: boolean;
      supportsMidRunInput: boolean;
      reportsUsage: boolean;
      reportsLimits: boolean;
      execution: { shell: boolean; filesystem: boolean; web: string };
      auth: { state: string; account?: string };
      limits?: { window: string; usedPercent: number; resetsAt?: string }[];
    };
    providerDetail: Record<string, unknown>;
  } | null;
}

export interface CapabilityChange { assistant_id: string; field: string; old_value: string; new_value: string; source: string; observed_at: string }

export interface QuotaBlocker { assistantId: string; reason: string; kind: string; source: string; observedAt: string; retryAt?: string; resetProvenance: string; scope: { bucket?: string; account?: string } }
export interface WaitHistoryEntry { at: string; actor: string; outcome: string; reason?: string }
/** Frontend view of the kernel `WaitCondition` served by `/api/tasks` and `/api/tasks/:id` (K1 time / K2 quota). */
export interface TaskWait {
  generation: number;
  state: string;
  kind: "time" | "quota" | "dependency";
  reason: string;
  notBefore: string;
  checkpointId?: string;
  autoWakes?: number;
  assistants?: string[];
  /** K4 dependency subjects — the tasks that must be terminal before a wake. */
  dependsOn?: string[];
  onDependencyFailure?: "cancel" | "wake-anyway" | "wait-input";
  history?: WaitHistoryEntry[];
  blockers?: QuotaBlocker[];
}

/** One `/api/scheduler/status` snapshot — scheduler ownership plus optional K3 idle probes. */
export interface SchedulerStatus {
  enabled: boolean;
  armed: boolean;
  dueConditions: number;
  openDispatches: number;
  lastTick: string | null;
  probesEnabled: boolean;
  probes: Array<{
    assistantId: string;
    attemptedAt: string;
    outcome: "ok" | "unavailable" | "unauthorized" | "unsupported";
    ageMs: number;
    detail?: string;
  }>;
}

export interface Dispatch {
  dispatch_id: string;
  task_id: string;
  condition_generation: number;
  origin: string;
  execution_path: string;
  phase: string;
  created_at: string;
  updated_at: string;
  checkpoint_id: string | null;
  routing_decision_id: number | null;
  session_id: string | null;
  reason: string | null;
}

export interface TaskSummary {
  wait?: TaskWait;
  schedulerEnabled?: boolean;
  id: string;
  goal: string;
  state: string;
  phase: string | null;
  profile: string;
  repoPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingExplanation {
  candidates: Array<{
    assistantId: string;
    passedFilters: boolean;
    filterFailures: string[];
    quota?: { usedPercent: number; resetsAt?: string };
  }>;
  ruleFired: string;
  chosen?: string;
  tieBreaker?: string;
  userOverride?: string;
}

export interface TaskEvent {
  run_id: string;
  seq: number;
  ts: string;
  type: string;
  phase: string | null;
  summary: string;
  payload: Record<string, unknown> | null;
  assistant_id: string;
}

export interface TaskDetail {
  schedulerEvents?: Array<{ id: number; at: string; type: string; payload: Record<string, unknown> }>;
  dispatches?: Dispatch[];
  wait?: TaskWait;
  schedulerEnabled?: boolean;
  id: string;
  goal: string;
  state: string;
  activity_phase: string | null;
  profile: string;
  repo_path: string | null;
  branch: string | null;
  envelope: {
    goal: string;
    constraints: string[];
    status: { state: string; phase?: string };
    completed: string[];
    remaining: string[];
    decisions: { text: string; madeBy: string; at: string }[];
    artifacts: {
      changedFiles: string[];
      testResults: { at: string; passed: number; failed: number }[];
    };
  };
  runs: Array<{
    id: string;
    assistant_id: string;
    state: string;
    usage: Record<string, unknown> | null;
    started_at: string;
    ended_at: string | null;
    /** K7. `resolvedModelId: null` = the provider reported no model identity. */
    modelIdentity?: {
      requestedSelector: string | null;
      resolvedModelId: string | null;
      resolvedSource: string;
      servingProvider: string | null;
    };
  }>;
  active: boolean;
}

/** K7 catalog entry as served by `GET /api/models`. Evidence, never a score. */
export interface CatalogModel {
  modelId: string;
  provider: string;
  displayName?: string;
  aliases: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  availableVia: string[];
  status: string;
  freshness: string;
  catalogRevision: string;
  provenance: { source: string; tier: string; observedAt: string; attribution?: string };
  pricing: Array<{
    inputPerMtok: number;
    outputPerMtok: number;
    currency: string;
    pricingVersion: string;
    appliesTo?: { servingProvider: string; accountKind?: string };
    provenance: { source: string; tier: string; observedAt: string; attribution?: string };
  }>;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    if (res.status === 401) { emitAuthExpired(); throw new AuthExpiredError(); }
    const body: unknown = await res.json().catch(() => ({}));
    const detail = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  workspace: () => req<Workspace>("/api/workspace"),
  assistants: () => req<Assistant[]>("/api/assistants"),
  changes: () => req<CapabilityChange[]>("/api/assistants/changes"),
  syncAssistant: (id: string) => req<unknown>(`/api/assistants/${id}/sync`, { method: "POST" }),
  runNow: (id: string, generation: number) => req(`/api/tasks/${id}/run-now`, { method: "POST", body: JSON.stringify({ generation }) }),
  schedulerStatus: () => req<SchedulerStatus>("/api/scheduler/status"),
  attachWait: (id: string, wait: { kind: "time" | "quota"; notBefore: string; reason?: string }) =>
    req<TaskWait>(`/api/tasks/${id}/wait`, { method: "POST", body: JSON.stringify(wait) }),
  tasks: () => req<TaskSummary[]>("/api/tasks"),
  task: (id: string) => req<TaskDetail>(`/api/tasks/${id}`),
  createTask: (body: { goal: string; constraints?: string[]; repoPath?: string; profile?: string; wait?: { kind: "time"; notBefore: string } }) =>
    req<{ taskId: string }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  route: (id: string, assistantId?: string) =>
    req<RoutingExplanation>(`/api/tasks/${id}/route`, {
      method: "POST",
      body: JSON.stringify({ assistantId }),
    }),
  start: (id: string, assistantId?: string) =>
    req<{ runId: string; assistantId: string }>(`/api/tasks/${id}/start`, {
      method: "POST",
      body: JSON.stringify({ assistantId }),
    }),
  events: (id: string) => req<TaskEvent[]>(`/api/tasks/${id}/events`),
  routing: (id: string) =>
    req<Array<{ chosen: string | null; at: string; explanation: RoutingExplanation }>>(
      `/api/tasks/${id}/routing`,
    ),
  approve: (id: string, requestId: string, approved: boolean) =>
    req<{ ok: true }>(`/api/tasks/${id}/input`, {
      method: "POST",
      body: JSON.stringify({ kind: "approval", requestId, approved }),
    }),
  cancel: (id: string) => req<{ ok: true }>(`/api/tasks/${id}/cancel`, { method: "POST" }),
  checkpoint: (id: string) =>
    req<{ id: string; gitRef: string | null; at: string }>(`/api/tasks/${id}/checkpoint`, {
      method: "POST",
    }),
  checkpoints: (id: string) =>
    req<Array<{ id: string; reason: string; at: string; gitRef: string | null }>>(
      `/api/tasks/${id}/checkpoints`,
    ),
  handoff: (id: string, to?: string) =>
    req<{ runId: string; assistantId: string }>(`/api/tasks/${id}/handoff`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }),
  handoffs: (id: string) =>
    req<
      Array<{
        id: string;
        trigger: string;
        at: string;
        from_assistant: string | null;
        to_assistant: string | null;
      }>
    >(`/api/tasks/${id}/handoffs`),
  models: () =>
    req<{ catalogRevision: string; models: CatalogModel[]; refreshes: Array<{ source: string; status: string; detail: string | null; finishedAt: string }> }>(
      "/api/models",
    ),
  refreshModels: () => req<{ attempts: Array<{ source: string; status: string; entries: number; detail?: string }> }>("/api/models/refresh", { method: "POST" }),
  cooldowns: () =>
    req<Array<{ assistantId: string; reason: string; until: string }>>("/api/cooldowns"),
  startParallel: (id: string, assistants: string[], mode: "compare" | "race") =>
    req<{ runs: Array<{ runId: string; assistantId: string }> }>(`/api/tasks/${id}/parallel`, {
      method: "POST",
      body: JSON.stringify({ assistants, mode }),
    }),
  comparison: (id: string) => req<Comparison>(`/api/tasks/${id}/comparison`),
  resolveComparison: (id: string, winnerRunId: string, reason?: string) =>
    req<{ mergedRef: string | null }>(`/api/tasks/${id}/comparison/resolve`, {
      method: "POST",
      body: JSON.stringify({ winnerRunId, reason }),
    }),
  scores: () => req<AssistantScore[]>("/api/scores"),
  sessions: (taskId: string) => req<SessionSummary[]>(`/api/tasks/${taskId}/sessions`),
  session: (id: string) => req<SessionDetail>(`/api/sessions/${id}`),
  verification: (id: string) => req<SessionVerification>(`/api/sessions/${id}/verification`),
  sessionsByGroup: (groupId: string) =>
    req<SessionSummary[]>(`/api/sessions?groupId=${encodeURIComponent(groupId)}`),
  sessionsByParent: (parentTaskId: string) =>
    req<SessionSummary[]>(`/api/sessions?parentTaskId=${encodeURIComponent(parentTaskId)}`),
};

export interface SessionVerification {
  sessionId: string;
  revisions: Array<{
    id: string;
    sessionId: string;
    executionRequestId: string;
    revision: number;
    supersedesRevisionId: string | null;
    planFingerprint: string;
    plan: unknown | null;
    reason: "initial" | "post_change" | "recovery";
    createdAt: string;
  }>;
  runs: Array<{
    id: string;
    sessionId: string;
    executionRequestId: string;
    planRevisionId: string;
    state: "ready" | "claimed" | "completed" | "interrupted";
    claimedAt: string | null;
    evaluation: unknown | null;
    artifacts: unknown;
    interruptionReason: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

/** One row of the Execution Harness session list for a task (§11 drill-down). */
export interface SessionSummary {
  sessionId: string;
  executionRequestId: string;
  assistantId: string;
  /** Primary session vocabulary (§5). */
  sessionState: string;
  /** Legacy `runs.state`, still served during the dual-field window. */
  state: string;
  attempt: number;
  providerStartAcked: boolean;
  cancelRequested: boolean;
  settlementOwner: string | null;
  correlation: { parentTaskId: string | null; groupId: string | null };
  startedAt: string | null;
  endedAt: string | null;
}

export interface SessionResult {
  outcome: "completed" | "failed" | "cancelled" | "timed_out" | "yielded";
  terminalState: string;
  failure?: { kind: string; retryable: boolean; message: string };
  verification?: { passed: boolean; checks: Array<{ name: string; passed: boolean; required: boolean; summary: string }> };
  /** Optional in the type because a corrupt durable row can be missing it. */
  enforcement?: { tools: string; budget: string; isolation: string };
  usage?: { inputTokens?: number; outputTokens?: number; accounting: string };
  checkpoint?: { attempted: boolean; committed: boolean; checkpointId?: string; gitRef?: string };
}

export interface SessionRequestView {
  id: string;
  attempt: number;
  assistantId: string;
  model: { id: string } | null;
  routingDecisionRef: string;
  requestFingerprint: string;
  fingerprintAlgorithm: string;
  promptSource: "fresh" | "handoff" | "resume";
  promptSourceRef: string | null;
  originEnvelopeId: string | null;
  superseded: boolean;
  policy: Record<string, unknown> | null;
  verification: unknown;
  origin: { kind: string; envelopeId?: string; sessionId?: string; checkpointId?: string } | null;
  createdAt: string;
}

export interface SessionDetail extends Omit<SessionSummary, "correlation"> {
  taskId: string;
  version: number;
  providerSessionRef: string | null;
  lease: { expiresAt: string | null } | null;
  /** null when the request row is missing/corrupt. */
  correlation: { parentTaskId: string | null; groupId: string | null } | null;
  request: SessionRequestView | null;
  /** verification + enforcement live inside `result`, not duplicated. */
  result: SessionResult | null;
  checkpoints: Array<{ id: string; reason: string; gitRef: string | null; diffStat: string | null; at: string }>;
  handoffEnvelopes: Array<{ id: string; state: string; checkpointId: string; reason: string }>;
  approvals: Array<{ id: string; providerRequestId: string; state: string; decision: string | null }>;
  audit: Array<{ seq: number; ts: string; type: string; summary: string; payload: unknown }>;
}

export interface Competitor {
  runId: string;
  assistantId: string;
  state: string;
  outcome: string | null;
  branch: string | null;
  durationMs: number | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  tests: { passed?: number; failed?: number } | null;
  diff: { diffStat: string; changedFiles: string[]; insertions: number; deletions: number } | null;
}

export interface Comparison {
  mode: string;
  decided: { winnerRunId: string | null; decidedBy: string; mergedRef: string | null; at: string } | null;
  competitors: Competitor[];
}

export interface AssistantScore {
  assistantId: string;
  runs: number;
  successRate: number;
  medianDurationMs?: number;
  medianTokens?: number;
  testPassRate?: number;
  failovers: number;
  errors: number;
}
import { AuthExpiredError, emitAuthExpired } from "./auth.js";
