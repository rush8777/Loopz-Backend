import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

describe("team migration", () => {
  const files: string[] = [];
  afterEach(() => {
    for (const file of files.splice(0)) if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  it("deduplicates existing memberships safely before adding the unique index", () => {
    const file = path.join(os.tmpdir(), `team-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    files.push(file);
    const sqlite = new Database(file);
    sqlite.exec(`
      CREATE TABLE organizations (id text PRIMARY KEY NOT NULL);
      CREATE TABLE users (id text PRIMARY KEY NOT NULL);
      CREATE TABLE memberships (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL,
        org_id text NOT NULL,
        role text NOT NULL,
        created_at integer NOT NULL
      );
      INSERT INTO organizations (id) VALUES ('org_1');
      INSERT INTO users (id) VALUES ('user_1');
      INSERT INTO memberships (id, user_id, org_id, role, created_at) VALUES
        ('viewer', 'user_1', 'org_1', 'VIEWER', 1),
        ('owner', 'user_1', 'org_1', 'OWNER', 2),
        ('member', 'user_1', 'org_1', 'MEMBER', 3);
    `);
    const migrationPath = fileURLToPath(new URL("../drizzle/0026_team_invitations.sql", import.meta.url));
    for (const statement of fs.readFileSync(migrationPath, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    const rows = sqlite.prepare("SELECT id, role FROM memberships WHERE user_id = ? AND org_id = ?").all("user_1", "org_1") as { id: string; role: string }[];
    expect(rows).toEqual([{ id: "owner", role: "OWNER" }]);
    expect(() => sqlite.prepare("INSERT INTO memberships (id, user_id, org_id, role, created_at) VALUES (?, ?, ?, ?, ?)").run("duplicate", "user_1", "org_1", "MEMBER", 4)).toThrow();
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organization_invitations'").get()).toBeTruthy();
    sqlite.close();
  });
});
