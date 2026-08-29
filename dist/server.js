import { env } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./app.js";
const db = createDb(env.DATABASE_URL);
runMigrations(db);
const app = await buildApp(db);
app
    .listen({ port: env.PORT, host: "0.0.0.0" })
    .then(() => {
    console.log(`analytics-platform-backend listening on :${env.PORT}`);
})
    .catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map