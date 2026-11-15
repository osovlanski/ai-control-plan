/**
 * P0-7a (docs/agentic-os-auto-copilot-plan.md §C.5, D-14): the external heartbeat.
 *
 * While the autopilot is not `stopped` (running, or draining a phase that is still executing), the
 * plane pings an external dead-man's-switch URL once per `intervalMs` (default 10 min). The request
 * is a bare GET: no body, no headers beyond the runtime's own, nothing but the check id that the URL
 * already carries. A missed ping is noticed by the external service, which emails itay; that is the
 * point, because a stale-tick flag on this box dies with the box.
 *
 * The URL is a secret of the plane user, read per ping from `urlFile` (a regular file of this user,
 * mode 0600 or tighter) and registered for redaction. It is never stored: the ledger records when a
 * ping was tried, whether it got a 2xx, and the HTTP status or error class.
 *
 * The ledger (`autopilot_heartbeats`) also records a `paused` row the first tick the autopilot is
 * found stopped after a ping, so the morning report can tell silence while stopped (not a gap) from
 * silence while it should have been pinging (a gap: the plane or the box was down).
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { registerSecret } from "@agent-plane/core";
import type { Db } from "../db/index.js";

export interface HeartbeatConfig { urlFile: string; intervalMs: number }
export const HEARTBEAT_DEFAULT_INTERVAL_MS = 10 * 60_000;
/** A ping that does not answer in this long is recorded as failed. */
const PING_TIMEOUT_MS = 10_000;

export type HeartbeatFetch = (url: string, init: { method: "GET"; redirect: "error"; signal: AbortSignal }) => Promise<{ status: number }>;

export interface HeartbeatDeps {
  db: Db;
  config: HeartbeatConfig;
  now: () => Date;
  fetch?: HeartbeatFetch;
}

/** Reads the ping URL with the same ownership rule as the GitHub token file. Throws a reason with no URL in it. */
export function readHeartbeatUrlFile(path: string): string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (err) {
    throw new Error(`heartbeat url file unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let url: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error("heartbeat url file must be a regular file of this user with mode 0600 or tighter");
    url = readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
  if (!url) throw new Error("heartbeat url file is empty");
  registerSecret(url);
  if (!/^https:\/\/[^/\s]+(\/\S*)?$/.test(url)) throw new Error("heartbeat url must be a single https URL");
  return url;
}

export class AutopilotHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly fetchFn: HeartbeatFetch;

  constructor(private readonly d: HeartbeatDeps) {
    this.fetchFn = d.fetch ?? ((url, init) => fetch(url, init));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.d.config.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One evaluation: ping when the autopilot is live, else close the last ping run with a `paused` row. Never throws. */
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const { db } = this.d;
    const status = (db.prepare("SELECT status FROM autopilot_state WHERE id = 1").get() as { status: string }).status;
    const at = this.d.now().toISOString();
    if (status === "stopped") {
      const last = db.prepare("SELECT kind FROM autopilot_heartbeats ORDER BY id DESC LIMIT 1").get() as { kind: string } | undefined;
      if (last?.kind === "ping") db.prepare("INSERT INTO autopilot_heartbeats(at, kind) VALUES (?, 'paused')").run(at);
      return;
    }
    let ok = 0;
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      const url = readHeartbeatUrlFile(this.d.config.urlFile);
      const res = await this.fetchFn(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      httpStatus = res.status;
      ok = res.status >= 200 && res.status < 300 ? 1 : 0;
      if (!ok) error = `http ${res.status}`;
    } catch (err) {
      // An error class only: a fetch message can carry the URL.
      error = err instanceof Error && err.message.startsWith("heartbeat url") ? err.message : `ping failed (${err instanceof Error ? err.name : "error"})`;
    }
    db.prepare("INSERT INTO autopilot_heartbeats(at, kind, ok, http_status, error) VALUES (?, 'ping', ?, ?, ?)").run(at, ok, httpStatus, error);
  }
}

export interface HeartbeatGap { from: string; to: string; ms: number; kind: "silence" | "failed" }
export interface HeartbeatSummary {
  tracked: boolean;
  intervalMs: number | null;
  pings: number;
  failed: number;
  gaps: HeartbeatGap[] | null;
  detail: string;
}

/**
 * The window's heartbeat from the ledger. A `silence` gap is a stretch inside [opensAt, min(closesAt, now)]
 * longer than twice the interval after a ping (or a failed ping) with no later row, which is what a dead plane
 * leaves; silence after a `paused` row is the autopilot being stopped and is not a gap. A `failed` gap is a run
 * of consecutive failed pings, from the first failure to the next successful ping (or the end of the span).
 * Silence before the first ping of the window is not counted: nothing says the autopilot was running then.
 */
export function heartbeatSummary(db: Db, config: HeartbeatConfig | undefined, window: { opensAt: string; closesAt: string } | null, now: Date): HeartbeatSummary {
  if (!config) return { tracked: false, intervalMs: null, pings: 0, failed: 0, gaps: null, detail: "autopilot.heartbeat is not configured" };
  if (!window) return { tracked: true, intervalMs: config.intervalMs, pings: 0, failed: 0, gaps: [], detail: "no window has opened" };
  const endMs = Math.min(Date.parse(window.closesAt), now.getTime());
  const end = new Date(endMs).toISOString();
  // The last row before the window decides whether a ping run was live as the window opened.
  const before = db.prepare("SELECT at, kind, ok FROM autopilot_heartbeats WHERE at < ? ORDER BY at DESC, id DESC LIMIT 1").get(window.opensAt) as Row | undefined;
  const rows = db.prepare("SELECT at, kind, ok FROM autopilot_heartbeats WHERE at >= ? AND at <= ? ORDER BY at, id").all(window.opensAt, end) as Row[];
  const limit = 2 * config.intervalMs;
  const gaps: HeartbeatGap[] = [];
  const pushGap = (fromMs: number, toMs: number, kind: HeartbeatGap["kind"]) => {
    if (toMs > fromMs) gaps.push({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), ms: toMs - fromMs, kind });
  };
  let live = before?.kind === "ping" ? Math.max(Date.parse(window.opensAt), Date.parse(before.at)) : undefined;
  let failingSince = before?.kind === "ping" && before.ok === 0 ? Date.parse(window.opensAt) : undefined;
  for (const r of rows) {
    const t = Date.parse(r.at);
    if (live !== undefined && t - live > limit) pushGap(live, t, "silence");
    if (r.kind === "paused") {
      if (failingSince !== undefined) pushGap(failingSince, t, "failed");
      failingSince = undefined;
      live = undefined;
      continue;
    }
    if (r.ok === 0) failingSince ??= t;
    else if (failingSince !== undefined) { pushGap(failingSince, t, "failed"); failingSince = undefined; }
    live = t;
  }
  if (live !== undefined && endMs - live > limit) pushGap(live, endMs, "silence");
  if (failingSince !== undefined) pushGap(failingSince, endMs, "failed");
  gaps.sort((a, b) => a.from.localeCompare(b.from));
  const pings = rows.filter((r) => r.kind === "ping");
  return {
    tracked: true, intervalMs: config.intervalMs, pings: pings.length, failed: pings.filter((r) => r.ok === 0).length, gaps,
    detail: `a gap is over ${Math.round(limit / 60_000)}m without a ping while the autopilot was live, or a run of failed pings`,
  };
}

interface Row { at: string; kind: "ping" | "paused"; ok: number | null }
