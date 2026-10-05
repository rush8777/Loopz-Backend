import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import rawBody from "fastify-raw-body";
import { sql } from "drizzle-orm";
import { env } from "./config.js";
import type { Db } from "./db/client.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOrgRoutes } from "./routes/orgs.js";
// Legacy Behavioral Intelligence routes are intentionally dormant.
// import { registerPatternRoutes } from "./routes/patterns.js";
// import { registerAnalysisRoutes } from "./routes/analysis.js";
// import { registerPatternObserverRoutes } from "./routes/pattern-observer.js";
import { registerElementRoutes } from "./routes/elements.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerTrackedUserRoutes } from "./routes/tracked-users.js";
import { registerSegmentRoutes } from "./routes/segments.js";
import { registerFunnelRoutes } from "./routes/funnels.js";
import { registerAnonymousUserRoutes } from "./routes/anonymous-users.js";
import { registerPublicConfigRoutes } from "./routes/public-config.js";
import { registerPublicEventsRoutes } from "./routes/public-events.js";
import { registerPublicReplayRoutes } from "./routes/public-replay.js";
import { registerPublicElementsRoutes } from "./routes/public-elements.js";
import { registerHeatmapRoutes } from "./routes/heatmaps.js";
import { registerExperienceRoutes } from "./routes/experiences.js";
import { registerPublicExperienceRoutes } from "./routes/public-experiences.js";
import { registerPublicChecklistRoutes } from "./routes/public-checklists.js";
import { registerDashboardRoutes } from "./routes/dashboards.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerPublicSdkVerificationRoutes, registerSdkVerificationRoutes } from "./routes/sdk-verifications.js";
import type { VerifyGoogleCredential } from "./lib/google-auth.js";

export async function buildApp(db: Db, options: { verifyGoogleCredential?: VerifyGoogleCredential } = {}) {
  const app = Fastify({ logger: false });
  const dashboardOrigin = new URL(env.DASHBOARD_URL).origin;

  await app.register(cors, {
    // Dashboard routes may receive bearer tokens, so only the configured
    // dashboard origin is allowed. The public SDK endpoints remain usable on
    // customer sites, but never opt in to credentialed browser requests.
    delegator: (request, callback) => {
      const isPublicRoute = request.url.startsWith("/public/");
      callback(null, {
        origin: isPublicRoute ? true : dashboardOrigin,
        methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: !isPublicRoute,
      });
    },
  });


  // Global default is generous (dashboard traffic, authenticated); the
  // public routes below get their own tighter, per-route limits since
  // they're what an attacker would actually target (no credentials required).
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await app.register(rawBody, { global: false, encoding: "utf8", runFirst: true });

  registerAuthRoutes(app, db, options.verifyGoogleCredential);
  registerOrgRoutes(app, db);
  registerInvitationRoutes(app, db);
  registerBillingRoutes(app, db);
  // registerPatternRoutes(app, db);
  // registerAnalysisRoutes(app, db);
  // registerPatternObserverRoutes(app, db);
  registerElementRoutes(app, db);
  registerSessionRoutes(app, db);
  registerPageRoutes(app, db);
  registerEventRoutes(app, db);
  registerTrackedUserRoutes(app, db);
  registerAnonymousUserRoutes(app, db);
  registerSegmentRoutes(app, db);
  registerFunnelRoutes(app, db);
  registerHeatmapRoutes(app, db);
  registerExperienceRoutes(app, db);
  registerDashboardRoutes(app, db);
  registerAnalyticsRoutes(app, db);
  registerSdkVerificationRoutes(app, db);

  await app.register(async (publicScope) => {
    await publicScope.register(rateLimit, { global: true, max: 60, timeWindow: "1 minute" });
    registerPublicConfigRoutes(publicScope, db);
    registerPublicSdkVerificationRoutes(publicScope, db);
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

  await app.register(async (publicExperienceScope) => {
    await publicExperienceScope.register(rateLimit, { global: true, max: 180, timeWindow: "1 minute" });
    registerPublicExperienceRoutes(publicExperienceScope, db);
    registerPublicChecklistRoutes(publicExperienceScope, db);
  });

  app.get("/health", async (_request, reply) => {
    try {
      await db.run(sql`SELECT 1`);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  return app;
}
