import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const app = buildServer({ config, db });

app.log.info(
  { workspace: config.workspace, dir: config.dir, db: config.dbPath },
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
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
