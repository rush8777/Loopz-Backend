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
//# sourceMappingURL=transaction.js.map