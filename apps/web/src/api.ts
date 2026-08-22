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

export interface TaskSummary {
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
  }>;
  active: boolean;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const detail = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  workspace: () => req<Workspace>("/api/workspace"),
  assistants: () => req<Assistant[]>("/api/assistants"),
  syncAssistant: (id: string) => req<unknown>(`/api/assistants/${id}/sync`, { method: "POST" }),
  tasks: () => req<TaskSummary[]>("/api/tasks"),
  task: (id: string) => req<TaskDetail>(`/api/tasks/${id}`),
  createTask: (body: { goal: string; constraints?: string[]; repoPath?: string; profile?: string }) =>
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
};
