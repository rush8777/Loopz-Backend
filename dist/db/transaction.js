import { sql } from "drizzle-orm";
/**
 * Async transaction boundary for application code.
 *
 * better-sqlite3's Drizzle adapter only accepts a synchronous callback, so
 * routes previously had to call driver-specific `.run()`/`.get()` methods.
 * Keep that SQLite constraint here in the DB layer: awaited Drizzle builders
 * execute synchronously today, while a future async driver can replace this
 * implementation with `db.transaction(async (tx) => ...)` without changing
 * route/service code.
 */
export async function runInTransaction(db, work) {
    await db.run(sql.raw("BEGIN"));
    try {
        const result = await work(db);
        await db.run(sql.raw("COMMIT"));
        return result;
    }
    catch (error) {
        await db.run(sql.raw("ROLLBACK"));
        throw error;
    }
}
//# sourceMappingURL=transaction.js.map