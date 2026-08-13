import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

const db = createDb(process.env.DATABASE_URL ?? "./dev.db");
runMigrations(db);
console.log("migrated");
