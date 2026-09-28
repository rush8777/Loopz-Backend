import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** SQLite implementation of a UTC YYYY-MM-DD bucket for timestamp-ms columns. */
export function utcDayBucket(timestamp: SQLWrapper): SQL<string> {
  return sql<string>`strftime('%Y-%m-%d', ${timestamp} / 1000, 'unixepoch')`;
}
