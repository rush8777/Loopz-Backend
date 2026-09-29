import type { Db, DbTransaction } from "./client.js";

/**
 * Async transaction boundary for application code.
 *
 * The libSQL driver owns the transaction and coordinates it at the database.
 * There is deliberately no process-local queue: correctness must hold across
 * multiple backend instances connected to the same Turso database.
 */
export function runInTransaction<T>(db: Db, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return db.transaction(work);
}
