import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client.js";

export function runMigrations(db: Db) {
  const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
  migrate(db, { migrationsFolder });
}
