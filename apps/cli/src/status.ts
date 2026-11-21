/**
 * `aos status` (p1-3 slice 1): a one-shot health readout over the plane's own routes, the reads
 * the web header and scheduler readout make. Read-only. It prints what the plane serves and adds
 * only the exit code: 1 when the plane reports itself unhealthy or the enabled scheduler is not
 * armed, so a heartbeat or cron can call it.
 */
import { parseArgs } from "node:util";
import { redactSecrets } from "@agent-plane/core";
import type { TaskSummary } from "../../web/src/api.js";
import type { PlaneClient } from "./client.js";

export type StatusCapability = "tasks.read" | "schedules.read" | "sessions.read";

export interface StatusDeps {
  connect(capability: StatusCapability, options: { api?: string; credential?: string }): PlaneClient;
  out(text: string): void;
  err(text: string): void;
  now?: () => Date;
}

export const USAGE = `usage: aos status [--json] [--api <origin>] [--credential <path>]

One read-only health readout: API and event versions, workspace and migrations, assistants,
the scheduler, active cooldowns, how many tasks need you, and unresolved session inputs when
session input is on.

Routes: GET /api/meta, /api/health, /api/workspace, /api/cooldowns, /api/tasks (tasks.read);
GET /api/scheduler/status (schedules.read); GET /api/inputs/unresolved (sessions.read, only when
the workspace advertises sessionInput.enabled).

Options:
  --json                       print the served reads under their route names
  --api <origin>               plane origin on loopback (default: workspace config, or AOS_API_URL)
  --credential <path>          bearer credential file (default: the workspace's, or AOS_CREDENTIAL_FILE)

Exit codes: 0 healthy, 1 degraded (health is not ok, or the scheduler is enabled and not armed)
or failure, 2 usage.`;

export const STATUS_ROUTES = Object.freeze([
  "GET /api/meta", "GET /api/health", "GET /api/workspace", "GET /api/cooldowns", "GET /api/tasks",
  "GET /api/scheduler/status", "GET /api/inputs/unresolved",
]);

interface Meta { apiVersion: string; eventVersion: string }
interface Health { status: string; workspace: string; migrations: number; now: string }
interface Workspace { workspace: string; assistants: string[]; sessionInput?: { enabled: boolean }; scheduler?: { enabled: boolean } }
interface Scheduler { enabled: boolean; armed: boolean; dueConditions: number; openDispatches: number; lastTick: string | null; enabledSchedules: number; nextScheduleFireAt: string | null }
interface Cooldown { assistantId: string; reason: string; until: string }

export async function runStatus(argv: string[], deps: StatusDeps): Promise<number> {
  let values: { json?: boolean; api?: string; credential?: string; help?: boolean };
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { json: { type: "boolean" }, api: { type: "string" }, credential: { type: "string" }, help: { type: "boolean", short: "h" } } });
    if (parsed.positionals.length) { deps.err(`aos status takes no argument\n\n${USAGE}`); return 2; }
    values = parsed.values;
  } catch (e) { deps.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`); return 2; }
  if (values.help) { deps.out(USAGE); return 0; }
  const opts = { api: values.api, credential: values.credential };
  try {
    const tasksRead = deps.connect("tasks.read", opts);
    const [meta, health, workspace, cooldowns, tasks] = await Promise.all([
      tasksRead.request<Meta>("GET", "/api/meta"),
      tasksRead.request<Health>("GET", "/api/health"),
      tasksRead.request<Workspace>("GET", "/api/workspace"),
      tasksRead.request<Cooldown[]>("GET", "/api/cooldowns"),
      tasksRead.request<TaskSummary[]>("GET", "/api/tasks"),
    ]);
    const scheduler = await deps.connect("schedules.read", opts).request<Scheduler>("GET", "/api/scheduler/status");
    const unresolved = workspace.sessionInput?.enabled
      ? (await deps.connect("sessions.read", opts).request<{ inputs: unknown[] }>("GET", "/api/inputs/unresolved")).inputs
      : null;
    const now = (deps.now ?? (() => new Date()))().getTime();
    const active = cooldowns.filter((c) => Date.parse(c.until) > now);
    const needsYou = tasks.filter((t) => t.stage?.value === "needs-you");
    const degraded = [
      health.status !== "ok" ? `health is ${health.status}` : "",
      scheduler.enabled && !scheduler.armed ? "the scheduler is enabled but not armed" : "",
    ].filter(Boolean);
    const print = (t: string) => deps.out(redactSecrets(t));
    if (values.json) {
      print(JSON.stringify({
        "/api/meta": meta, "/api/health": health, "/api/workspace": workspace, "/api/cooldowns": cooldowns,
        "/api/scheduler/status": scheduler, "/api/inputs/unresolved": unresolved === null ? null : { inputs: unresolved },
        tasks: { total: tasks.length, needsYou: needsYou.map((t) => t.id) }, degraded,
      }, null, 2));
    } else {
      print([
        `Plane ${degraded.length ? "DEGRADED" : "ok"} · workspace ${health.workspace} · API ${meta.apiVersion} · events ${meta.eventVersion} · ${health.migrations} migrations · plane clock ${health.now}`,
        ...degraded.map((d) => `  - ${d}`),
        `Assistants: ${workspace.assistants.join(", ") || "none configured"}`,
        `Scheduler: ${scheduler.enabled ? (scheduler.armed ? "armed" : "enabled, NOT armed") : "off"} · due ${scheduler.dueConditions} · open dispatches ${scheduler.openDispatches} · schedules ${scheduler.enabledSchedules}${scheduler.nextScheduleFireAt ? ` (next ${scheduler.nextScheduleFireAt})` : ""} · last tick ${scheduler.lastTick ?? "never"}`,
        `Cooldowns: ${active.length ? active.map((c) => `${c.assistantId} until ${c.until} (${c.reason})`).join("; ") : "none active"}`,
        `Tasks: ${tasks.length} · needs you: ${needsYou.length ? needsYou.map((t) => t.id).join(", ") : "none"}`,
        `Unresolved inputs: ${unresolved === null ? "session input is off" : unresolved.length}`,
      ].join("\n"));
    }
    return degraded.length ? 1 : 0;
  } catch (e) {
    deps.err(redactSecrets(`aos status: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
}
