// Drizzle does not currently expose one table-alias helper with compatible
// types across its SQLite and PostgreSQL query builders. Keep the dialect
// choice in the DB layer so application query code does not import sqlite-core.
export { alias as databaseAlias } from "drizzle-orm/sqlite-core";
