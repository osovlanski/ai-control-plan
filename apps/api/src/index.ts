import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { buildServer } from "./server.js";
import { EventRetention } from "./modules/retention.js";
import { scheduleDailyJobs } from "./modules/jobs.js";
import { setExitEvidence, SystemExitEvidence } from "./modules/exit-evidence.js";
import { stopExitWatches } from "./modules/attempts.js";

const config = loadConfig();
const db = openDb(config.dbPath);
// qcq-04b (packet 2.6.1): this host's exit evidence, installed before anything reconciles, so the
// boot sweep reads the real boot id and units. Only the real entry installs it: buildServer (tests)
// keeps NO_EXIT_EVIDENCE, where every attempt is released at the end of its stream.
const exitEvidence = new SystemExitEvidence({ agentUser: config.execution.agentUser, disabled: process.env.AGENT_PLANE_PROVIDER_SCOPES === "off" });
setExitEvidence(db, exitEvidence);
const { app, registry, orchestrator, scheduler, modelCatalog, registryFederation, memoryFederation, acceptance, dispatcher, restore } = buildServer({ config, db });

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
    // Why a lane has no strong exit evidence (null: provider units are assigned there).
    providerScopes: { plane: exitEvidence.unavailable("plane") ?? null, agent: config.execution.agentUser ? exitEvidence.unavailable("agent") ?? null : "no agent user" },
  },
  "workspace instance booting",
);

try {
  await app.listen({ host: config.api.host, port: config.api.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// B2 (D-B): the remote-only listener for the private Web link, on its own loopback port. The local
// listener above is already serving and stays unchanged. Remote listens only after the pinned OIDC
// issuer is ready; until then nothing answers on its port (fail closed) and a retry runs each minute.
let remoteRetry: NodeJS.Timeout | undefined;
const listenRemote = app.listenRemote;
if (listenRemote) {
  const attempt = async (): Promise<void> => {
    try { await listenRemote(); }
    catch (err) {
      app.log.error({ event: "remote_auth", action: "listen", outcome: "refused", reason: err instanceof Error ? err.message : String(err) }, "remote listener not started; retrying in 60 s");
      remoteRetry = setTimeout(() => void attempt(), 60_000);
      remoteRetry.unref();
    }
  };
  await attempt();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopJobs();
    stopExitWatches(db);
    if (remoteRetry) clearTimeout(remoteRetry);
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
