import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sdkVerificationChallenges, sites } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
export const SDK_VERIFICATION_TTL_MS = 30_000;
function serializedChallenge(challenge, now = new Date()) {
    if (challenge.acknowledgedAt) {
        return {
            id: challenge.id,
            status: "connected",
            expiresAt: challenge.expiresAt,
            detectedAt: challenge.acknowledgedAt,
        };
    }
    return {
        id: challenge.id,
        status: challenge.expiresAt.getTime() <= now.getTime() ? "expired" : "pending",
        expiresAt: challenge.expiresAt,
        detectedAt: null,
    };
}
export function registerSdkVerificationRoutes(app, db) {
    app.post("/orgs/:orgId/sites/:siteId/sdk-verifications", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
        if (!site || site.orgId !== request.membership.orgId) {
            return reply.code(404).send({ error: "site_not_found" });
        }
        const now = new Date();
        const [challenge] = await db
            .insert(sdkVerificationChallenges)
            .values({
            id: `sdkv_${nanoid(32)}`,
            siteId: site.id,
            createdAt: now,
            expiresAt: new Date(now.getTime() + SDK_VERIFICATION_TTL_MS),
        })
            .returning();
        return reply.code(201).send({ verification: serializedChallenge(challenge, now) });
    });
    app.get("/orgs/:orgId/sites/:siteId/sdk-verifications/:verificationId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, verificationId } = request.params;
        const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
        if (!site || site.orgId !== request.membership.orgId) {
            return reply.code(404).send({ error: "site_not_found" });
        }
        const [challenge] = await db
            .select()
            .from(sdkVerificationChallenges)
            .where(and(eq(sdkVerificationChallenges.id, verificationId), eq(sdkVerificationChallenges.siteId, site.id)))
            .limit(1);
        if (!challenge)
            return reply.code(404).send({ error: "verification_not_found" });
        return reply.send({ verification: serializedChallenge(challenge) });
    });
}
export function registerPublicSdkVerificationRoutes(app, db) {
    app.post("/public/sites/:siteId/sdk-verifications/:verificationId/ack", async (request, reply) => {
        const { siteId, verificationId } = request.params;
        const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.publicId, siteId)).limit(1);
        if (!site)
            return reply.code(404).send({ error: "verification_not_found" });
        const [challenge] = await db
            .select()
            .from(sdkVerificationChallenges)
            .where(and(eq(sdkVerificationChallenges.id, verificationId), eq(sdkVerificationChallenges.siteId, site.id)))
            .limit(1);
        if (!challenge)
            return reply.code(404).send({ error: "verification_not_found" });
        if (challenge.acknowledgedAt) {
            return reply.send({ verification: serializedChallenge(challenge) });
        }
        const now = new Date();
        if (challenge.expiresAt.getTime() <= now.getTime()) {
            return reply.code(410).send({ error: "verification_expired" });
        }
        const [acknowledged] = await db
            .update(sdkVerificationChallenges)
            .set({ acknowledgedAt: now })
            .where(and(eq(sdkVerificationChallenges.id, challenge.id), eq(sdkVerificationChallenges.siteId, site.id)))
            .returning();
        return reply.send({ verification: serializedChallenge(acknowledged, now) });
    });
}
//# sourceMappingURL=sdk-verifications.js.map