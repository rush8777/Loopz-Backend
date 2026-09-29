import { sql } from "drizzle-orm";
const transactionTails = new WeakMap();
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
    const previous = transactionTails.get(db) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    transactionTails.set(db, previous.then(() => turn));
    await previous;
    let began = false;
    try {
        await db.run(sql.raw("BEGIN"));
        began = true;
        const result = await work(db);
        await db.run(sql.raw("COMMIT"));
        began = false;
        return result;
    }
    catch (error) {
        if (began)
            await db.run(sql.raw("ROLLBACK"));
        throw error;
    }
    finally {
        release();
    }
}
//# sourceMappingURL=transaction.js.map