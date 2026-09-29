import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/libsql/migrator";
import { sql } from "drizzle-orm";
export async function runMigrations(db) {
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
    try {
        await migrate(db, { migrationsFolder });
    }
    finally {
        await db.run(sql.raw("PRAGMA foreign_keys = ON"));
    }
}
export async function checkDatabaseReadiness(db) {
    await db.run(sql `SELECT 1`);
}
//# sourceMappingURL=migrate.js.map