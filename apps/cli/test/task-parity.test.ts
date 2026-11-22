/**
 * Observed-call parity for the P0 read rows of docs/cli/aos-parity.md (acceptance item 2): for
 * each row, the web client function and the `aos` command both reach the row's route, observed
 * through a recording `fetch`, against a real plane for the CLI. The live stream has no client
 * function (TaskDetail opens an EventSource on it), so its row checks the web source for that URL.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../web/src/api.js";
import { aos, bearer, bootPlane, type Plane } from "./helpers.js";

type WebFn = "tasks" | "task" | "events" | "session" | "workspace" | "schedulerStatus" | "cooldowns" | "estimate" | "recordedEstimates";
interface Row { route: string; web: WebFn | { source: string; pattern: RegExp }; cli: { group: "task" | "status"; argv: string[] } }

const ROWS: readonly Row[] = [
  { route: "GET /api/tasks", web: "tasks", cli: { group: "task", argv: ["ls"] } },
  { route: "GET /api/tasks/:id", web: "task", cli: { group: "task", argv: ["show", "T"] } },
  { route: "GET /api/tasks/:id/events", web: "events", cli: { group: "task", argv: ["events", "T"] } },
  { route: "GET /api/tasks/:id/events/stream", web: { source: "../../web/src", pattern: /EventSource\([^)]*\/api\/tasks\/\$\{[^}]+\}\/events\/stream/ }, cli: { group: "task", argv: ["events", "T", "--follow"] } },
  { route: "GET /api/sessions/:id", web: "session", cli: { group: "task", argv: ["verdict", "T"] } },
  { route: "GET /api/tasks/:id/estimate", web: "estimate", cli: { group: "task", argv: ["estimate", "T"] } },
  { route: "GET /api/tasks/:id/estimates/recorded", web: "recordedEstimates", cli: { group: "task", argv: ["estimate", "T", "--recorded"] } },
  { route: "GET /api/workspace", web: "workspace", cli: { group: "status", argv: [] } },
  { route: "GET /api/scheduler/status", web: "schedulerStatus", cli: { group: "status", argv: [] } },
  { route: "GET /api/cooldowns", web: "cooldowns", cli: { group: "status", argv: [] } },
];

let plane: Plane | undefined;
afterEach(async () => { vi.unstubAllGlobals(); await plane?.close(); plane = undefined; });

describe("P0 read parity: web client and aos reach the same routes", () => {
  it("every row's route is registered by the plane", async () => {
    plane = await bootPlane();
    for (const { route } of ROWS) {
      const [method, url] = route.split(" ") as ["GET", string];
      expect(plane.built.app.hasRoute({ method, url }), route).toBe(true);
    }
  });

  it("each web side reaches its row's route", async () => {
    for (const row of ROWS) {
      if (typeof row.web !== "string") {
        // Any web source file may open it (today TaskDetail.tsx), so the check survives a move.
        const root = join(dirname(fileURLToPath(import.meta.url)), row.web.source);
        const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
        const pattern = row.web.pattern;
        expect(files.some((f) => pattern.test(readFileSync(join(root, f), "utf8"))), row.route).toBe(true);
        continue;
      }
      const fetchMock = vi.fn().mockResolvedValue(new Response("[]"));
      vi.stubGlobal("fetch", fetchMock);
      await (api[row.web] as (id: string) => Promise<unknown>)("T-1");
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit | undefined];
      const path = String(url).replace("/T-1", "/:id");
      expect(`${init?.method ?? "GET"} ${path}`, row.web).toBe(row.route);
    }
  });

  it("each aos command reaches its row's route on a real plane", async () => {
    plane = await bootPlane();
    plane.built.scheduler.startTimer();
    const id = plane.built.tasks.create({ goal: "Document the parser module" }).taskId;
    const res = await plane.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: { authorization: `Bearer ${bearer(plane)}` }, payload: { assistantId: "fake-a" } });
    expect(res.statusCode, res.body).toBe(200);
    await plane.built.orchestrator.waitForSettled(id);
    const runId = (plane.db.prepare("SELECT id FROM runs WHERE task_id = ?").get(id) as { id: string }).id;
    for (const row of ROWS) {
      const seen = new Set<string>();
      const fetchImpl: typeof fetch = (input, init) => {
        seen.add(`${init?.method ?? "GET"} ${new URL(String(input)).pathname.replace(`/${id}`, "/:id").replace(`/${runId}`, "/:id")}`);
        return fetch(input, init);
      };
      const argv = row.cli.argv.map((a) => (a === "T" ? id : a));
      const r = await aos(plane, argv, { group: row.cli.group, fetchImpl });
      expect(r.code, `${row.cli.group} ${argv.join(" ")}: ${r.err}`).toBe(0);
      expect([...seen], `aos ${row.cli.group} ${argv.join(" ")} reaches ${row.route}`).toContain(row.route);
    }
  });
});
