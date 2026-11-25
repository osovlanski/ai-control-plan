/**
 * P0-7b (docs/agentic-os-auto-copilot-plan.md §C.5, D-11): back up and restore the plane database.
 *
 *   pnpm --filter @agent-plane/api backup
 *       Online backup of the running plane's database into `autopilot.backup.localDir`
 *       (default `<workspace>/backups`), integrity-checked, with a sha256 manifest; prunes local
 *       copies older than `keepDays` (7) and copies the new one to `destination` if set.
 *   pnpm --filter @agent-plane/api backup -- list [--dest dir:/path]
 *   pnpm --filter @agent-plane/api backup -- restore --from <backup.db | latest> [--dest dir:/path]
 *       The plane must be stopped (a process holding the database refuses it). Writes the
 *       `restored_at.json` marker first, moves the current database aside (never deletes it) and
 *       puts the backup in place. The next boot stops the autopilot, treats the open window as
 *       exhausted and reconciles; a start then needs the report read back with `autopilot.operate`.
 *
 * `--db <path>` and `--dir <workspace dir>` override the configured ones (drills, tests).
 */
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { listLocal, parseDestination, restoreBackup, takeBackup } from "../modules/backup.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const command = args[0] && !args[0].startsWith("--") ? args[0] : "backup";

const config = loadConfig();
const dir = flag("--dir") ?? config.dir;
const dbPath = flag("--db") ?? (flag("--dir") ? join(dir, "agent-plane.db") : config.dbPath);
const settings = config.autopilot.backup ?? { keepDays: 7 };
const localDir = flag("--local-dir") ?? settings.localDir ?? join(dir, "backups");
const destSpec = flag("--dest") ?? settings.destination;
const destination = destSpec ? parseDestination(destSpec) : undefined;
const out = (o: unknown) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

try {
  if (command === "backup") {
    const r = await takeBackup({ dbPath, localDir, keepDays: settings.keepDays, ...(destination ? { destination } : {}) });
    out({ backup: r.manifest, path: r.path, pruned: r.pruned, ...(r.copiedTo ? { copiedTo: r.copiedTo } : {}) });
  } else if (command === "list") {
    out({ local: listLocal(localDir), ...(destination ? { [destination.label]: await destination.list() } : {}) });
  } else if (command === "restore") {
    const from = flag("--from");
    if (!from) throw new Error("restore needs --from <backup.db> or --from latest");
    let backupPath: string;
    if (from === "latest") {
      const name = destination ? (await destination.list()).at(-1) : listLocal(localDir).at(-1);
      if (!name) throw new Error(`no backup in ${destination?.label ?? localDir}`);
      backupPath = destination ? await destination.get(name, join(localDir, "fetched")) : join(localDir, name);
    } else {
      backupPath = from;
    }
    const r = restoreBackup({ dbPath, workspaceDir: dir, backupPath });
    out({ restored: r.marker, marker: r.markerPath, movedAside: r.movedAside, next: "start the plane: it boots with the autopilot stopped and reconciles; read the report back before starting" });
  } else {
    throw new Error(`unknown command ${command}: backup | list | restore`);
  }
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
