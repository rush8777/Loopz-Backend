import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
export function runMigrations(db) {
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    migrate(db, { migrationsFolder });
}
//# sourceMappingURL=migrate.js.map