import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { expect, it } from "vitest";
import { createDb, closeDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { experienceEvents, experienceVersions, experiences, guideCaptureCheckpoints, organizations, sites, users } from "../src/db/schema.js";

it("upgrades a populated database and preserves widget revisions, events and capture checkpoints", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "geo-agent-migration-"));
  const db = createDb(join(temporary, "upgrade.db"));
  try {
    const migrations = join(temporary, "drizzle");
    await cp(new URL("../drizzle", import.meta.url), migrations, { recursive: true });
    const journalPath = join(migrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 42);
    await writeFile(journalPath, JSON.stringify(journal));
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await migrate(db, { migrationsFolder: migrations });
    await db.run(sql`PRAGMA foreign_keys = ON`);
    await db.insert(users).values({ id: "admin", email: "admin@example.test" });
    await db.insert(organizations).values({ id: "org", name: "Org" });
    await db.insert(sites).values({ id: "site", publicId: "public-site", name: "Site", orgId: "org" });
    const timestamp = new Date(1000);
    await db.insert(experiences).values({
      id: "guide", siteId: "site", createdBy: "admin", kind: "guide", name: "Guide",
      builderMode: "onsite", status: "published", publishedVersionId: "v1", launchSetupCompletedAt: timestamp,
    });
    await db.insert(experienceVersions).values({ id: "v1", experienceId: "guide", versionNumber: 1, revision: 7, state: "published", definition: { steps: [] }, createdBy: "admin" });
    await db.insert(experienceEvents).values({ id: "event", siteId: "site", experienceId: "guide", versionId: "v1", eventType: "guide_completed", timestamp });
    await db.insert(guideCaptureCheckpoints).values({ experienceId: "guide", checkpoint: { targets: [] }, revision: 3 });
    const snapshot = () => Promise.all([
      db.select().from(experiences), db.select().from(experienceVersions), db.select().from(experienceEvents), db.select().from(guideCaptureCheckpoints),
    ]);
    const before = await snapshot();
    await runMigrations(db);
    expect(await snapshot()).toEqual(before);
    expect((await db.run(sql`PRAGMA foreign_key_check`)).rows).toEqual([]);
    await expect(db.insert(experiences).values({
      id: "geo", siteId: "site", createdBy: "admin", kind: "widget", widgetType: "geo_agent", builderMode: "geo_agent", name: "Geo",
    })).resolves.toBeDefined();
  } finally {
    await closeDb(db);
    await rm(temporary, { recursive: true, force: true });
  }
});
