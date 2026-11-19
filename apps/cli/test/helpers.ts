/** A real plane (routes, router, database) on a loopback port, and the CLI pointed at it. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../api/src/config.js";
import { openDb, type Db } from "../../api/src/db/index.js";
import { buildServer, type BuiltServer } from "../../api/src/server.js";
import { connect } from "../src/client.js";
import { runRuntimes } from "../src/runtimes.js";

export const TWO_FAKES = "assistants:\n  fake-a:\n    provider: fake\n  fake-b:\n    provider: fake\n";

export interface Plane { home: string; origin: string; built: BuiltServer; db: Db; close(): Promise<void> }

export async function bootPlane(yaml = TWO_FAKES): Promise<Plane> {
  const home = mkdtempSync(join(tmpdir(), "agent-plane-aos-cli-"));
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(join(home, "personal", "config.yaml"), yaml);
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  const db = openDb(config.dbPath);
  const built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
  return {
    home, origin, built, db,
    async close() {
      await built.orchestrator.shutdown();
      await built.app.close();
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface Run { code: number; out: string; err: string }

/** `aos runtimes …` in-process, with the workspace env of `plane` and an optional fetch seam. */
export async function aos(plane: Pick<Plane, "home" | "origin">, argv: string[], opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const env = opts.env ?? { AGENT_PLANE_HOME: plane.home, AOS_API_URL: plane.origin };
  const code = await runRuntimes(argv, {
    connect: (capability, options) => connect(capability, { ...options, env, fetchImpl: opts.fetchImpl }),
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
