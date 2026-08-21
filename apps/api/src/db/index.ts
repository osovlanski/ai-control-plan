import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Opens (creating if needed) the workspace DB and applies pending migrations. */
export function openDb(dbPath: string): Db {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Minimal forward-only migration runner: numbered .sql files applied in order,
 * each inside a transaction, recorded in schema_migrations. No down migrations —
 * a single-user SQLite file restores from backup instead.
 */
export function migrate(db: Db, migrationsDir: string = MIGRATIONS_DIR): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );

  const applied = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((row) => (row as { name: string }).name),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    });
    apply();
    newlyApplied.push(file);
  }
  return newlyApplied;
}

export function appliedMigrations(db: Db): string[] {
  return db
    .prepare("SELECT name FROM schema_migrations ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}
