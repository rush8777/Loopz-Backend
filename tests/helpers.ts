import { closeDb, createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Fresh libSQL file per test suite so the same adapter family is exercised as production. */
export async function createTestDb(): Promise<{ db: Db; cleanup: () => void; file: string }> {
  const file = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = createDb(`file:${file}`);
  await runMigrations(db);
  return {
    db,
    cleanup: () => {
      void closeDb(db);
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
          if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EBUSY")) throw error;
        }
      }
    },
    file,
  };
}

export async function createTestApp(options: Parameters<typeof buildApp>[1] = {}) {
  const { db, cleanup } = await createTestDb();
  const app = await buildApp(db, options);
  return { app, db, cleanup };
}

export async function signup(app: Awaited<ReturnType<typeof buildApp>>, overrides: Partial<{ email: string; password: string; orgName: string }> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      password: overrides.password ?? "correct-horse-battery-staple",
    },
  });
  const account = res.json() as {
    user: { id: string; email: string };
    accessToken: string;
    refreshToken: string;
  };
  const onboarded = await app.inject({
    method: "POST",
    url: "/auth/onboarding",
    headers: { authorization: `Bearer ${account.accessToken}` },
    payload: { workspaceName: overrides.orgName ?? "Test Org", siteName: "Test site", domain: "https://example.test" },
  });
  const setup = onboarded.json() as { organization: { id: string; name: string } };
  return { ...account, org: setup.organization };
}
