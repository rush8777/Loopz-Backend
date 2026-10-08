/**
 * Async transaction boundary for application code.
 *
 * The libSQL driver owns the transaction and coordinates it at the database.
 * There is deliberately no process-local queue: correctness must hold across
 * multiple backend instances connected to the same Turso database.
 */
export function runInTransaction(db, work) {
    return db.transaction(work);
}
function retryableWriteConflict(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /SQLITE_BUSY|database is locked|transaction.*(busy|conflict)|write conflict/i.test(message);
}
/** Entitlement checks intentionally run in the same transaction as the write.
 * Concurrent writers may make a deferred SQLite transaction retry; retrying
 * the whole decision preserves the limit invariant across backend instances. */
export async function runEntitlementTransaction(db, work) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            return await db.transaction(work);
        }
        catch (error) {
            lastError = error;
            if (!retryableWriteConflict(error) || attempt === 4)
                throw error;
            await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
        }
    }
    throw lastError;
}
//# sourceMappingURL=transaction.js.map