import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sql } from "drizzle-orm";
export function runMigrations(db) {
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    db.run(sql.raw("PRAGMA foreign_keys = OFF"));
    try {
        migrate(db, { migrationsFolder });
    }
    finally {
        db.run(sql.raw("PRAGMA foreign_keys = ON"));
    }
}
//# sourceMappingURL=migrate.js.map