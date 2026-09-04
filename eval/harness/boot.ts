/**
 * Scenario boot helper (increment 3, plan §4). Builds a real `buildServer`
 * composition root against a fresh, disposable workspace — the same
 * production wiring `apps/api/src/index.ts` uses, no test-only shortcuts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ResolvedConfig } from "../../apps/api/src/config.js";
import { openDb, type Db } from "../../apps/api/src/db/index.js";
import { buildServer, type BuiltServer } from "../../apps/api/src/server.js";
import { bearerClient, type EvalClient } from "./client.js";

export interface BootedScenario {
  home: string;
  config: ResolvedConfig;
  db: Db;
  built: BuiltServer;
  client: EvalClient;
  close: () => Promise<void>;
}

export interface BootOptions {
  /** Extra top-level YAML appended to the generated config (e.g. custom `assistants:`). */
  extraConfigYaml?: string;
  /** Repo paths to allowlist for this run (the prepared fixture's temp path). */
  repoAllowlist?: string[];
  /** Force single-mode Harness routing on for this scenario's workspace. */
  harnessSingle?: boolean;
}

export async function bootScenario(opts: BootOptions = {}): Promise<BootedScenario> {
  const home = mkdtempSync(join(tmpdir(), "agent-plane-eval-"));
  const personalDir = join(home, "personal");
  const yaml = [
    opts.extraConfigYaml ?? "",
    opts.harnessSingle ? "execution:\n  harnessModes:\n    single: true\n" : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (yaml) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(personalDir, { recursive: true });
    writeFileSync(join(personalDir, "config.yaml"), yaml);
  }
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  if (opts.repoAllowlist) config.repoAllowlist.push(...opts.repoAllowlist);
  const db = openDb(config.dbPath);
  const built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
  const client = bearerClient(config);
  return {
    home,
    config,
    db,
    built,
    client,
    close: async () => {
      await built.app.close();
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
