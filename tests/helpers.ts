import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Fresh sqlite file per test suite - real file (not :memory:) so drizzle's migrator behaves identically to production. */
export function createTestDb(): { db: Db; cleanup: () => void } {
  const file = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = createDb(file);
  runMigrations(db);
  return {
    db,
    cleanup: () => {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
      }
    },
  };
}

export async function createTestApp() {
  const { db, cleanup } = createTestDb();
  const app = await buildApp(db);
  return { app, db, cleanup };
}

export async function signup(app: Awaited<ReturnType<typeof buildApp>>, overrides: Partial<{ email: string; password: string; orgName: string }> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      password: overrides.password ?? "correct-horse-battery-staple",
      orgName: overrides.orgName ?? "Test Org",
    },
  });
  return res.json() as {
    user: { id: string; email: string };
    org: { id: string; name: string };
    accessToken: string;
    refreshToken: string;
  };
}
