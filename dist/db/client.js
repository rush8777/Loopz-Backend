import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
function normalizeDatabaseUrl(url) {
    if (/^(file|libsql|https?|wss?):/i.test(url))
        return url;
    return `file:${url}`;
}
export function createDb(url, authToken) {
    const client = createClient({
        url: normalizeDatabaseUrl(url),
        ...(authToken ? { authToken } : {}),
    });
    return drizzle(client, { schema });
}
export async function closeDb(db) {
    db.$client.close();
}
//# sourceMappingURL=client.js.map