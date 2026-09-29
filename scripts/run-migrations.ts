import "dotenv/config";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

const db = createDb(process.env.DATABASE_URL ?? "file:./dev.db", process.env.DATABASE_AUTH_TOKEN);
await runMigrations(db);
console.log("migrated");
