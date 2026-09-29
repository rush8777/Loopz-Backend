import { createClient } from "@libsql/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

describe("team migration", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

  it("deduplicates memberships through the libSQL driver before adding the unique index", async () => {
    const file = path.join(os.tmpdir(), `team-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const client = createClient({ url: `file:${file}` });
    cleanups.push(() => { client.close(); try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* libSQL may release its Windows file handle asynchronously. */ } });
    await client.executeMultiple(`
      CREATE TABLE organizations (id text PRIMARY KEY NOT NULL);
      CREATE TABLE users (id text PRIMARY KEY NOT NULL);
      CREATE TABLE memberships (id text PRIMARY KEY NOT NULL, user_id text NOT NULL, org_id text NOT NULL, role text NOT NULL, created_at integer NOT NULL);
      INSERT INTO organizations (id) VALUES ('org_1');
      INSERT INTO users (id) VALUES ('user_1');
      INSERT INTO memberships (id, user_id, org_id, role, created_at) VALUES
        ('viewer', 'user_1', 'org_1', 'VIEWER', 1), ('owner', 'user_1', 'org_1', 'OWNER', 2), ('member', 'user_1', 'org_1', 'MEMBER', 3);
    `);
    const migrationPath = fileURLToPath(new URL("../drizzle/0026_team_invitations.sql", import.meta.url));
    for (const statement of fs.readFileSync(migrationPath, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await client.execute(statement);
    }
    const rows = (await client.execute({ sql: "SELECT id, role FROM memberships WHERE user_id = ? AND org_id = ?", args: ["user_1", "org_1"] })).rows;
    expect(rows).toEqual([{ id: "owner", role: "OWNER" }]);
    await expect(client.execute({ sql: "INSERT INTO memberships (id, user_id, org_id, role, created_at) VALUES (?, ?, ?, ?, ?)", args: ["duplicate", "user_1", "org_1", "MEMBER", 4] })).rejects.toThrow();
    expect((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organization_invitations'")).rows).toHaveLength(1);
  });
});
