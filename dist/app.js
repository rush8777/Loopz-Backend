import { registerAgentSkills } from "./routes/agent-skills.js";
import { registerGeoAgentRoutes } from "./routes/geo-agent.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { createKnowledgeEmbedder } from "./lib/knowledge/embeddings.js";
import { startKnowledgeWorker } from "./lib/knowledge/jobs.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import rawBody from "fastify-raw-body";
import { sql } from "drizzle-orm";
import { env } from "./config.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOrgRoutes } from "./routes/orgs.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerTrackedUserRoutes } from "./routes/tracked-users.js";
import { registerSegmentRoutes } from "./routes/segments.js";
import { registerFunnelRoutes } from "./routes/funnels.js";
import { registerAnonymousUserRoutes } from "./routes/anonymous-users.js";
import { registerPublicConfigRoutes } from "./routes/public-config.js";
import { registerPublicEventsRoutes } from "./routes/public-events.js";
import { registerRetiredCaptureRoutes } from "./routes/retired-capture.js";
import { registerExperienceRoutes } from "./routes/experiences.js";
import { registerPublicExperienceRoutes } from "./routes/public-experiences.js";
import { registerPublicChecklistRoutes } from "./routes/public-checklists.js";
import { registerDashboardRoutes } from "./routes/dashboards.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerPublicSdkVerificationRoutes, registerSdkVerificationRoutes } from "./routes/sdk-verifications.js";
import { registerPublicThemeRoutes, registerThemeRoutes } from "./routes/themes.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerPublicContactRoutes } from "./routes/public-contact.js";
import { sendContactEmail } from "./lib/contact.js";
import { createConfiguredAiProvider } from "./lib/ai/providers/index.js";
export async function buildApp(db, options = {}) {
    const app = Fastify({ logger: false });
    const aiProvider = options.aiProvider ?? createConfiguredAiProvider();
    const dashboardOrigin = new URL(env.DASHBOARD_URL).origin;
    const dashboardOrigins = new Set([dashboardOrigin]);
    // Vite serves the dashboard over HTTP locally by default. Keep the
    // configured dashboard origin for redirects, but accept both local schemes
    // during development so a stale https://localhost value cannot break CORS.
    if (env.NODE_ENV !== "production") {
        dashboardOrigins.add("http://localhost:5173");
        dashboardOrigins.add("https://localhost:5173");
        dashboardOrigins.add("http://127.0.0.1:5173");
        dashboardOrigins.add("https://127.0.0.1:5173");
    }
    await app.register(cors, {
        // Dashboard routes may receive bearer tokens, so only the configured
        // dashboard origin is allowed. The public SDK endpoints remain usable on
        // customer sites, but never opt in to credentialed browser requests.
        delegator: (request, callback) => {
            const isPublicRoute = request.url.startsWith("/public/");
            callback(null, {
                origin: isPublicRoute ? true : [...dashboardOrigins],
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
    registerSessionRoutes(app, db);
    registerPageRoutes(app, db);
    registerEventRoutes(app, db);
    registerTrackedUserRoutes(app, db);
    registerAnonymousUserRoutes(app, db);
    registerSegmentRoutes(app, db);
    registerFunnelRoutes(app, db);
    registerExperienceRoutes(app, db);
    registerDashboardRoutes(app, db);
    registerAnalyticsRoutes(app, db);
    registerSdkVerificationRoutes(app, db);
    registerThemeRoutes(app, db);
    registerAiRoutes(app, db, aiProvider);
    registerAgentSkills(app, db, aiProvider);
    let stopKnowledgeWorker;
    const knowledgeEmbedder = options.knowledgeEmbedder === undefined ? createKnowledgeEmbedder() : options.knowledgeEmbedder;
    registerKnowledgeRoutes(app, db, knowledgeEmbedder);
    registerGeoAgentRoutes(app, db, aiProvider, knowledgeEmbedder);
    if (env.KNOWLEDGE_WORKER_ENABLED) {
        app.addHook("onReady", async () => {
            stopKnowledgeWorker = startKnowledgeWorker(db, knowledgeEmbedder);
        });
        app.addHook("onClose", async () => { await stopKnowledgeWorker?.(); });
    }
    await app.register(async (publicScope) => {
        await publicScope.register(rateLimit, { global: true, max: 60, timeWindow: "1 minute" });
        registerPublicConfigRoutes(publicScope, db);
        registerPublicSdkVerificationRoutes(publicScope, db);
        registerPublicThemeRoutes(publicScope, db);
    });
    // Separate low-volume limit for unauthenticated marketing contact submissions.
    await app.register(async (contactScope) => {
        await contactScope.register(rateLimit, { global: true, max: 5, timeWindow: "15 minutes" });
        registerPublicContactRoutes(contactScope, options.sendContactEmail ?? sendContactEmail);
    });
    await app.register(async (publicEventsScope) => {
        // Higher ceiling than /public/config: this fires on every batch
        // flush during a session (SDK's Batcher default is every 5s / 50
        // events), not once per page load.
        await publicEventsScope.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
        registerPublicEventsRoutes(publicEventsScope, db);
    });
    registerRetiredCaptureRoutes(app, db);
    await app.register(async (publicExperienceScope) => {
        await publicExperienceScope.register(rateLimit, { global: true, max: 180, timeWindow: "1 minute" });
        registerPublicExperienceRoutes(publicExperienceScope, db, aiProvider);
        registerPublicChecklistRoutes(publicExperienceScope, db);
    });
    app.get("/health", async (_request, reply) => {
        try {
            await db.run(sql `SELECT 1`);
            return { ok: true };
        }
        catch {
            return reply.code(503).send({ ok: false });
        }
    });
    return app;
}
//# sourceMappingURL=app.js.map