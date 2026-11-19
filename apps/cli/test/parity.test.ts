/**
 * UI / CLI parity (design §E, Agent Runtime Registry PR 6). One table lists each action's route,
 * the web client function that reaches it and the `aos runtimes` command that reaches it. The test
 * fails when a route is not registered, when the Agents app calls a client function the table does
 * not list, when either client reaches a route the table does not list, or when an action has a web
 * side and no CLI side (or the reverse). Calls are observed, not declared: the web client runs
 * against a recording `fetch`, the CLI against a real plane through a recording `fetch`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../web/src/api.js";
import { COMMAND_ROUTES } from "../src/runtimes.js";
import { aos, bootPlane, type Plane } from "./helpers.js";

type WebFn = "runtimeCatalog" | "assistants" | "changes" | "cooldowns" | "syncAssistant" | "testAssistant" | "disableAssistant" | "enableAssistant";

interface Row { action: string; route: string; web: WebFn; cli: string[][] }

/**
 * The §E matrix rows that have a route. Rows with no route (install, configure, authenticate) are
 * text, not calls: `show` prints the install/sign-in links and `catalog <provider> --snippet` the
 * config entry, both from reads below. Cooldowns are not an §E row; the Agents card shows them, so
 * `show` does too.
 */
const PARITY: readonly Row[] = [
  { action: "Discover runtimes this build supports", route: "GET /api/runtimes/catalog", web: "runtimeCatalog", cli: [["catalog"], ["catalog", "fake"], ["catalog", "fake", "--snippet"], ["show", "A"]] },
  { action: "See configured instances + lifecycle; why not ready", route: "GET /api/assistants", web: "assistants", cli: [["ls"], ["show", "A"], ["catalog", "fake", "--snippet"]] },
  { action: "Capability changes", route: "GET /api/assistants/changes", web: "changes", cli: [["changes"]] },
  { action: "Active cooldown on the card", route: "GET /api/cooldowns", web: "cooldowns", cli: [["show", "A"]] },
  { action: "Capability sync", route: "POST /api/assistants/:id/sync", web: "syncAssistant", cli: [["sync", "A"]] },
  { action: "Test (conformance)", route: "POST /api/assistants/:id/test", web: "testAssistant", cli: [["test", "A"]] },
  { action: "Disable", route: "POST /api/assistants/:id/disable", web: "disableAssistant", cli: [["disable", "A"]] },
  { action: "Re-enable", route: "POST /api/assistants/:id/enable", web: "enableAssistant", cli: [["enable", "A"]] },
];

/**
 * Client calls in Agents.tsx that are not runtime-registry actions, each with why. Adding a call to
 * the Agents app means adding it to PARITY (with a CLI command) or here (with a reason).
 */
const NOT_RUNTIME_ACTIONS: Readonly<Record<string, string>> = {
  models: "ModelCatalogCard: the K7 model catalogue (models, not runtimes), outside design §E",
  refreshModels: "ModelCatalogCard: the K7 model catalogue refresh, outside design §E",
};

const ID = "fake-a";
const AGENTS = join(dirname(fileURLToPath(import.meta.url)), "../../web/src/shell/Agents.tsx");
const routeKey = (method: string, path: string) => `${method} ${path.replace(`/api/assistants/${ID}/`, "/api/assistants/:id/")}`;

let plane: Plane | undefined;
afterEach(async () => { vi.unstubAllGlobals(); await plane?.close(); plane = undefined; });

describe("UI / CLI parity (design §E)", () => {
  it("every row's route is registered by the plane", async () => {
    plane = await bootPlane();
    for (const row of PARITY) {
      const [method, url] = row.route.split(" ") as ["GET" | "POST", string];
      expect(plane.built.app.hasRoute({ method, url }), row.route).toBe(true);
    }
  });

  it("the Agents app calls only client functions in the table", () => {
    const called = new Set([...readFileSync(AGENTS, "utf8").matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]!));
    expect([...called].filter((fn) => !(fn in NOT_RUNTIME_ACTIONS)).sort()).toEqual(PARITY.map((r) => r.web).sort());
    for (const fn of Object.keys(NOT_RUNTIME_ACTIONS)) expect(called, `${fn} is still called; drop the stale exemption`).toContain(fn);
  });

  it("each web client function reaches exactly its row's route", async () => {
    for (const row of PARITY) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetchMock);
      const fn = api[row.web] as (id: string) => Promise<unknown>;
      await fn(ID);
      expect(fetchMock, row.web).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit | undefined];
      expect(routeKey(init?.method ?? "GET", url), row.web).toBe(row.route);
    }
  });

  it("each CLI command reaches only table routes, every row is reached, and COMMAND_ROUTES says so", async () => {
    plane = await bootPlane();
    const reached = new Map<string, Set<string>>();
    for (const row of PARITY) {
      for (const argv0 of row.cli) {
        const argv = argv0.map((a) => (a === "A" ? ID : a));
        const seen = new Set<string>();
        const recording: typeof fetch = (input, init) => {
          seen.add(routeKey(init?.method ?? "GET", new URL(String(input)).pathname));
          return fetch(input, init);
        };
        const r = await aos(plane, argv, { fetchImpl: recording });
        expect(r.code === 0 || (argv[0] === "test" && r.code === 1), `${argv.join(" ")}: ${r.err}`).toBe(true);
        expect(seen.has(row.route), `${argv.join(" ")} reaches ${row.route}`).toBe(true);
        for (const route of seen) expect(PARITY.map((x) => x.route), `${argv.join(" ")} reached ${route}`).toContain(route);
        const key = argv.includes("--snippet") ? "catalog --snippet" : argv[0]!;
        reached.set(key, new Set([...(reached.get(key) ?? []), ...seen]));
      }
    }
    for (const [key, routes] of Object.entries(COMMAND_ROUTES)) expect([...(reached.get(key) ?? [])].sort(), key).toEqual([...routes].sort());
    expect([...reached.keys()].sort()).toEqual(Object.keys(COMMAND_ROUTES).sort());
  });
});
