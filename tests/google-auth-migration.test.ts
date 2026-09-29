import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/auth.js";

async function applySqlMigration(client: Client, relativePath: string): Promise<void> {
  const migrationPath = fileURLToPath(new URL(relativePath, import.meta.url));
  for (const statement of fs.readFileSync(migrationPath, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) await client.execute(statement);
  }
}

describe("Google auth identity migration", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

  it("preserves users and related rows while making password_hash nullable", async () => {
    const file = path.join(os.tmpdir(), `google-auth-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const client = createClient({ url: `file:${file}` });
    cleanups.push(() => { client.close(); try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* libSQL may release its Windows file handle asynchronously. */ } });
    await client.execute("PRAGMA foreign_keys = OFF");
    const preservedHash = await hashPassword("correct-horse-battery-staple");
    await client.executeMultiple(`
      CREATE TABLE users (id text PRIMARY KEY NOT NULL, email text NOT NULL, password_hash text NOT NULL, name text, created_at integer NOT NULL);
      CREATE UNIQUE INDEX users_email_unique ON users (email);
      CREATE TABLE organizations (id text PRIMARY KEY NOT NULL);
      CREATE TABLE memberships (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id), org_id text NOT NULL REFERENCES organizations(id), role text NOT NULL, created_at integer NOT NULL);
      CREATE TABLE refresh_tokens (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id), token_hash text NOT NULL, expires_at integer NOT NULL, revoked_at integer, created_at integer NOT NULL);
      CREATE TABLE audit_logs (id text PRIMARY KEY NOT NULL, org_id text NOT NULL REFERENCES organizations(id), user_id text REFERENCES users(id), action text NOT NULL, detail text NOT NULL, created_at integer NOT NULL);
      CREATE TABLE organization_invitations (id text PRIMARY KEY NOT NULL, invited_by_user_id text NOT NULL REFERENCES users(id));
      CREATE TABLE experiences (id text PRIMARY KEY NOT NULL, created_by text NOT NULL REFERENCES users(id));
      INSERT INTO users VALUES ('usr_1', 'existing@example.com', '${preservedHash}', 'Existing', 123);
      INSERT INTO organizations VALUES ('org_1');
      INSERT INTO memberships VALUES ('mem_1', 'usr_1', 'org_1', 'OWNER', 124);
      INSERT INTO refresh_tokens VALUES ('rtk_1', 'usr_1', 'hash', 999999, NULL, 125);
      INSERT INTO audit_logs VALUES ('aud_1', 'org_1', 'usr_1', 'test', '{}', 126);
      INSERT INTO organization_invitations VALUES ('inv_1', 'usr_1');
      INSERT INTO experiences VALUES ('exp_1', 'usr_1');
    `);
    await applySqlMigration(client, "../drizzle/0029_google_auth_identities.sql");
    await client.execute("PRAGMA foreign_keys = ON");

    const migratedUser = (await client.execute("SELECT * FROM users")).rows[0];
    expect(migratedUser).toMatchObject({ id: "usr_1", password_hash: preservedHash, created_at: 123 });
    expect(await verifyPassword("correct-horse-battery-staple", String(migratedUser.password_hash))).toBe(true);
    await expect(client.execute({ sql: "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)", args: ["usr_2", "google@example.com", null, 124] })).resolves.toBeTruthy();
    expect((await client.execute("SELECT user_id FROM memberships")).rows[0].user_id).toBe("usr_1");
    expect((await client.execute("SELECT user_id FROM refresh_tokens")).rows[0].user_id).toBe("usr_1");
    expect((await client.execute("SELECT user_id FROM audit_logs")).rows[0].user_id).toBe("usr_1");
    expect((await client.execute("SELECT invited_by_user_id FROM organization_invitations")).rows[0].invited_by_user_id).toBe("usr_1");
    expect((await client.execute("SELECT created_by FROM experiences")).rows[0].created_by).toBe("usr_1");
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
    const indexNames = (await client.execute("PRAGMA index_list('user_auth_identities')")).rows.map((row) => row.name);
    expect(indexNames).toEqual(expect.arrayContaining([
      "user_auth_identities_provider_subject_uidx",
      "user_auth_identities_user_provider_uidx",
    ]));
    await client.execute("INSERT INTO user_auth_identities (id, user_id, provider, provider_subject, provider_email) VALUES ('aid_1', 'usr_2', 'google', 'sub_1', 'google@example.com')");
    await expect(client.execute("INSERT INTO user_auth_identities (id, user_id, provider, provider_subject, provider_email) VALUES ('aid_2', 'usr_1', 'google', 'sub_1', 'existing@example.com')")).rejects.toThrow();
  });
});
