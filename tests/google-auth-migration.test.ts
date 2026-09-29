import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

describe("Google auth identity migration", () => {
  const files: string[] = [];
  afterEach(() => {
    for (const file of files.splice(0)) if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  it("preserves existing users and hashes while making password_hash nullable", () => {
    const file = path.join(os.tmpdir(), `google-auth-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    files.push(file);
    const sqlite = new Database(file);
    sqlite.pragma("foreign_keys = OFF");
    sqlite.exec(`
      CREATE TABLE users (id text PRIMARY KEY NOT NULL, email text NOT NULL, password_hash text NOT NULL, name text, created_at integer NOT NULL);
      CREATE UNIQUE INDEX users_email_unique ON users (email);
      INSERT INTO users VALUES ('usr_1', 'existing@example.com', 'preserved-hash', 'Existing', 123);
    `);
    const migrationPath = fileURLToPath(new URL("../drizzle/0029_google_auth_identities.sql", import.meta.url));
    for (const statement of fs.readFileSync(migrationPath, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    expect(sqlite.prepare("SELECT * FROM users").get()).toMatchObject({ id: "usr_1", password_hash: "preserved-hash", created_at: 123 });
    expect(() => sqlite.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run("usr_2", "google@example.com", null, 124)).not.toThrow();
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_auth_identities'").get()).toBeTruthy();
    sqlite.close();
  });
});
