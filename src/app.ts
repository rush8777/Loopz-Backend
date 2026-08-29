import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "./db/client.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOrgRoutes } from "./routes/orgs.js";
import { registerPatternRoutes } from "./routes/patterns.js";
import { registerAnalysisRoutes } from "./routes/analysis.js";
import { registerPatternObserverRoutes } from "./routes/pattern-observer.js";
import { registerElementRoutes } from "./routes/elements.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerTrackedUserRoutes } from "./routes/tracked-users.js";
import { registerAnonymousUserRoutes } from "./routes/anonymous-users.js";
import { registerPublicConfigRoutes } from "./routes/public-config.js";
import { registerPublicEventsRoutes } from "./routes/public-events.js";
import { registerPublicReplayRoutes } from "./routes/public-replay.js";
import { registerPublicElementsRoutes } from "./routes/public-elements.js";

export async function buildApp(db: Db) {
  const app = Fastify({ logger: false });

  await app.register(cors, {
  // Configures Access-Control-Allow-Origin dynamically based on the request header
  origin: true, 
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});


  // Global default is generous (dashboard traffic, authenticated); the
  // public routes below get their own tighter, per-route limits since
  // they're what an attacker would actually target (no credentials required).
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  registerAuthRoutes(app, db);
  registerOrgRoutes(app, db);
  registerPatternRoutes(app, db);
  registerAnalysisRoutes(app, db);
  registerPatternObserverRoutes(app, db);
  registerElementRoutes(app, db);
  registerSessionRoutes(app, db);
  registerPageRoutes(app, db);
  registerEventRoutes(app, db);
  registerTrackedUserRoutes(app, db);
  registerAnonymousUserRoutes(app, db);

  await app.register(async (publicScope) => {
    await publicScope.register(rateLimit, { global: true, max: 60, timeWindow: "1 minute" });
    registerPublicConfigRoutes(publicScope, db);
  });

  await app.register(async (publicEventsScope) => {
    // Higher ceiling than /public/config: this fires on every batch
    // flush during a session (SDK's Batcher default is every 5s / 50
    // events), not once per page load.
    await publicEventsScope.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
    registerPublicEventsRoutes(publicEventsScope, db);
  });

  await app.register(async (publicReplayScope) => {
    // rrweb payloads are large (FullSnapshot especially) - a lower
    // request ceiling than the events endpoint, but generous enough for
    // a session's incremental-snapshot cadence.
    await publicReplayScope.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });
    registerPublicReplayRoutes(publicReplayScope, db);
  });

  await app.register(async (publicElementsScope) => {
    // Crawls fire on page load + SPA route change (ElementCrawler.ts) -
    // far less frequent than the events batch cadence, but an app with
    // heavy client-side navigation could still exceed /public/config's
    // once-per-load ceiling, so this gets its own, slightly higher limit.
    await publicElementsScope.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });
    registerPublicElementsRoutes(publicElementsScope, db);
  });

  app.get("/health", async () => ({ ok: true }));

  return app;
}
