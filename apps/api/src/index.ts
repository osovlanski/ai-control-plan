import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { buildServer } from "./server.js";
import { EventRetention } from "./modules/retention.js";
import { scheduleDailyJobs } from "./modules/jobs.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const { app, registry, orchestrator, scheduler, modelCatalog, registryFederation } = buildServer({ config, db });

registry.init();
const reconciled = await orchestrator.reconcileOnBoot();
await registry.syncChangedAll();
// Never blocks boot: a failure keeps the cached snapshot and is logged with its reason.
await registryFederation.sync();
await scheduler.reconcileOnBoot();
scheduler.startTimer();
const stopJobs = scheduleDailyJobs(config.sync.dailyHour, registry, new EventRetention(db), app.log, modelCatalog, registryFederation);

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
