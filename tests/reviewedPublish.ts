import type { FastifyInstance, InjectOptions } from "fastify";
/** Existing publish scenarios explicitly read/review the current draft first. */
export async function publishReviewed(app: FastifyInstance, options: InjectOptions & { url: string }) {
  const response = await app.inject({ method: "GET", url: options.url.replace(/\/publish$/, ""), headers: options.headers });
  const draft = response.json().draftVersion;
  return app.inject({ ...options, payload: { draftVersionId: draft?.id ?? "missing", revision: draft?.revision ?? 1 } });
}
