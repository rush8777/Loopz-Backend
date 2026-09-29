import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

function normalizeDatabaseUrl(url: string): string {
  if (/^(file|libsql|https?|wss?):/i.test(url)) return url;
  return `file:${url}`;
}

export function createDb(url: string, authToken?: string) {
  const client = createClient({
    url: normalizeDatabaseUrl(url),
    ...(authToken ? { authToken } : {}),
  });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbExecutor = Db | DbTransaction;

export async function closeDb(db: Db): Promise<void> {
  (db.$client as Client).close();
}
