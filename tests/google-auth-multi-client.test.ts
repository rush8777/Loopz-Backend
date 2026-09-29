import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { env } from "../src/config.js";
import { closeDb, createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { memberships, organizations, userAuthIdentities, users } from "../src/db/schema.js";
import { signup } from "./helpers.js";

describe("Google authentication across separate libSQL clients", () => {
  const originalGoogleClientId = env.GOOGLE_CLIENT_ID;
  afterEach(() => { env.GOOGLE_CLIENT_ID = originalGoogleClientId; });

  it("resolves simultaneous signups to one canonical account and workspace", async () => {
    env.GOOGLE_CLIENT_ID = "test-client-id";
    const file = path.join(os.tmpdir(), `google-multi-client-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const dbA = createDb(`file:${file}`);
    await runMigrations(dbA);
    const dbB = createDb(`file:${file}`);
    const verifier = async () => ({ subject: "shared-subject", email: "shared@example.com", name: "Shared User" });
    const [appA, appB] = await Promise.all([
      buildApp(dbA, { verifyGoogleCredential: verifier }),
      buildApp(dbB, { verifyGoogleCredential: verifier }),
    ]);
    try {
      const [first, second] = await Promise.all([
        appA.inject({ method: "POST", url: "/auth/google", payload: { credential: "one", orgName: "First Org" } }),
        appB.inject({ method: "POST", url: "/auth/google", payload: { credential: "two", orgName: "Second Org" } }),
      ]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
      expect(first.json().user.id).toBe(second.json().user.id);
      expect(await dbA.select().from(users)).toHaveLength(1);
      expect(await dbA.select().from(userAuthIdentities)).toHaveLength(1);
      expect(await dbA.select().from(organizations)).toHaveLength(1);
      expect(await dbA.select().from(memberships)).toHaveLength(1);
    } finally {
      await Promise.all([appA.close(), appB.close()]);
      await Promise.all([closeDb(dbA), closeDb(dbB)]);
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* libSQL can release the Windows handle asynchronously. */ }
    }
  });

  it("concurrently links one Google identity to an existing password user without another workspace", async () => {
    env.GOOGLE_CLIENT_ID = "test-client-id";
    const file = path.join(os.tmpdir(), `google-link-multi-client-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const dbA = createDb(`file:${file}`);
    await runMigrations(dbA);
    const dbB = createDb(`file:${file}`);
    const verifier = async () => ({ subject: "existing-subject", email: "existing@example.com", name: "Existing" });
    const [appA, appB] = await Promise.all([
      buildApp(dbA, { verifyGoogleCredential: verifier }),
      buildApp(dbB, { verifyGoogleCredential: verifier }),
    ]);
    try {
      const passwordAccount = await signup(appA, { email: "existing@example.com", orgName: "Existing Org" });
      const [first, second] = await Promise.all([
        appA.inject({ method: "POST", url: "/auth/google", payload: { credential: "one" } }),
        appB.inject({ method: "POST", url: "/auth/google", payload: { credential: "two" } }),
      ]);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(first.json().user.id).toBe(passwordAccount.user.id);
      expect(second.json().user.id).toBe(passwordAccount.user.id);
      expect(await dbA.select().from(users)).toHaveLength(1);
      expect(await dbA.select().from(userAuthIdentities)).toHaveLength(1);
      expect(await dbA.select().from(organizations)).toHaveLength(1);
      expect(await dbA.select().from(memberships)).toHaveLength(1);
    } finally {
      await Promise.all([appA.close(), appB.close()]);
      await Promise.all([closeDb(dbA), closeDb(dbB)]);
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* libSQL can release the Windows handle asynchronously. */ }
    }
  });
});
