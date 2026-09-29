import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { organizations } from "../src/db/schema.js";
import { runInTransaction } from "../src/db/transaction.js";
import { createTestDb } from "./helpers.js";

describe("local libSQL database", () => {
  it("starts from a local file, applies the complete migration chain, and queries it", async () => {
    const ctx = await createTestDb();
    try {
      const migrations = await ctx.db.all<{ count: number }>(sql`SELECT count(*) AS count FROM __drizzle_migrations`);
      expect(Number(migrations[0].count)).toBe(30);
      await expect(ctx.db.run(sql`SELECT 1`)).resolves.toBeTruthy();
    } finally {
      ctx.cleanup();
    }
  });

  it("commits all writes in a native transaction", async () => {
    const ctx = await createTestDb();
    try {
      await runInTransaction(ctx.db, async (tx) => {
        await tx.insert(organizations).values([{ name: "One" }, { name: "Two" }]);
      });
      expect(await ctx.db.select().from(organizations)).toHaveLength(2);
    } finally {
      ctx.cleanup();
    }
  });

  it("rolls back every write when a native transaction fails", async () => {
    const ctx = await createTestDb();
    try {
      await expect(runInTransaction(ctx.db, async (tx) => {
        await tx.insert(organizations).values({ name: "Must roll back" });
        throw new Error("force rollback");
      })).rejects.toThrow("force rollback");
      expect(await ctx.db.select().from(organizations)).toHaveLength(0);
    } finally {
      ctx.cleanup();
    }
  });
});
