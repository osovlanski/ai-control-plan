import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { buildServer } from "./server.js";
import { EventRetention } from "./modules/retention.js";
import { scheduleDailyJobs } from "./modules/jobs.js";
import { startRemoteListener } from "./auth/remote-listener.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const { app, remoteAuth, registry, orchestrator, scheduler, modelCatalog, registryFederation, memoryFederation, acceptance, dispatcher, restore } = buildServer({ config, db });

registry.init();
const reconciled = await orchestrator.reconcileOnBoot();
await registry.syncChangedAll();
// Never blocks boot: a failure keeps the cached snapshot and is logged with its reason.
await registryFederation.sync();
// O6 S3: Cockpit's memory bundle snapshot, same rules (feeds the memory shadow only).
await memoryFederation.sync();
// P0-4/P0-6: an acceptance run a crash interrupted is `crashed` (replay or blocked) before anything dispatches.
await acceptance?.reconcileOnBoot();
await scheduler.reconcileOnBoot();
// P0-7b (§C.5): a restored database gets its one reconciliation now, off the boot path. It reads
// GitHub and the disk and launches nothing; a start stays refused until its report is read back.
void restore.reconcileIfPending();
scheduler.startTimer();
// P0-6: the in-plane dispatcher. It selects only while the autopilot is running, which a boot never makes it.
dispatcher.startTimer();
// The daily job syncs the memory snapshot right after the registry's; a memory failure never fails the registry sync.
const federations = {
  sync: async () => {
    const result = await registryFederation.sync();
    await memoryFederation.sync().catch(() => undefined);
    return result;
  },
};
const stopJobs = scheduleDailyJobs(config.sync.dailyHour, registry, new EventRetention(db), app.log, modelCatalog, federations);

app.log.info(
  {
    workspace: config.workspace,
    dir: config.dir,
    db: config.dbPath,
    assistants: Object.keys(config.assistants),
    reconciledOrphans: reconciled,
  },
  "workspace instance booting",
);

try {
  await app.listen({ host: config.api.host, port: config.api.port });
  // B2 (D-B): the remote-only listener, after the local one is up. A failure here stops the process
  // rather than leaving a half-configured remote mode running.
  if (remoteAuth) await startRemoteListener(app, remoteAuth);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopJobs();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
