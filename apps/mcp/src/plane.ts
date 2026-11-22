/**
 * Loopback client for the plane API (C1 shapes, API 2.14). It holds the narrow MCP credential and
 * is the only place that secret is used: client tokens are never forwarded to the plane (T7).
 */
export interface PlaneResponse { status: number; body: Record<string, unknown> }

export class PlaneUnavailable extends Error {}

export interface PlaneTaskSummary {
  id: string; goal: string; state: string; repoPath: string | null;
  createdAt: string; updatedAt: string; stage?: { value: string; rule: string };
}

export interface PlaneTaskDetail {
  id: string; goal: string; state: string; repo_path: string | null; created_at: string; updated_at: string;
  runs: Array<{ id: string; assistant_id: string; state: string; started_at: string | null; ended_at: string | null }>;
}

export const MIN_API_VERSION: [number, number] = [2, 14];

export class PlaneClient {
  constructor(private readonly base: string, private readonly secret: () => string, private readonly timeoutMs = 10_000) {}

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<PlaneResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.secret()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new PlaneUnavailable("the plane did not answer");
    }
    let parsed: unknown = {};
    try { parsed = await res.json(); } catch { parsed = {}; }
    return { status: res.status, body: (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed }) as Record<string, unknown> };
  }

  async meta() { return this.request("GET", "/api/meta"); }
  async workspace() { return this.request("GET", "/api/workspace"); }
  async listTasks(): Promise<PlaneTaskSummary[]> {
    const res = await this.request("GET", "/api/tasks");
    if (res.status !== 200) throw new PlaneError(res);
    const list = (res.body as unknown as { value?: unknown }).value;
    if (!Array.isArray(list)) throw new PlaneError(res);
    return list as PlaneTaskSummary[];
  }
  async getTask(id: string) { return this.request("GET", `/api/tasks/${encodeURIComponent(id)}`); }
  async createTask(body: Record<string, unknown>) { return this.request("POST", "/api/tasks", body); }
  async startTask(id: string, body: Record<string, unknown>) { return this.request("POST", `/api/tasks/${encodeURIComponent(id)}/start`, body); }
}

export class PlaneError extends Error {
  constructor(readonly response: PlaneResponse) { super(`plane answered ${response.status}`); }
}

export function apiVersionAtLeast(version: unknown, min = MIN_API_VERSION): boolean {
  if (typeof version !== "string") return false;
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [maj, minr] = [Number(m[1]), Number(m[2])];
  return maj === min[0] && minr >= min[1];
}
