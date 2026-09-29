import { sql } from "drizzle-orm";
/** SQLite implementation of a UTC YYYY-MM-DD bucket for timestamp-ms columns. */
export function utcDayBucket(timestamp) {
    return sql `strftime('%Y-%m-%d', ${timestamp} / 1000, 'unixepoch')`;
}
//# sourceMappingURL=expressions.js.map