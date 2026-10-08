import { z } from "zod";
import { eq, and, isNull, sql } from "drizzle-orm";
import { users, organizations, memberships, refreshTokens, userAuthIdentities, sites, cuid } from "../db/schema.js";
import { hashPassword, verifyPassword, hashRefreshToken, issueSession, } from "../lib/auth.js";
import { authenticate } from "../middleware/authenticate.js";
import { env } from "../config.js";
import { normalizeEmail } from "../lib/invitations.js";
import { runInTransaction } from "../db/transaction.js";
import { verifyGoogleCredential as defaultVerifyGoogleCredential, } from "../lib/google-auth.js";
import { createGrowthTrial } from "../lib/entitlements/subscription.js";
import { generateSitePublicId } from "../lib/ids.js";
const signupSchema = z.object({
    email: z.string().trim().email(),
    password: z.string().min(10, "password must be at least 10 characters"),
    name: z.string().max(200).optional(),
});
const loginSchema = z.object({
    email: z.string().trim().email(),
    password: z.string().min(1),
});
const refreshSchema = z.object({
    refreshToken: z.string().min(1),
});
const googleSchema = z.object({
    credential: z.string().min(1),
});
const onboardingSchema = z.object({
    workspaceName: z.string().trim().min(1).max(200),
    siteName: z.string().trim().min(1).max(200),
    domain: z.string().trim().min(1).max(300),
});
function userJson(user) {
    return { id: user.id, email: user.email, name: user.name };
}
function databaseErrorMessage(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function isUniqueConstraintError(error) {
    return /unique constraint|constraint failed.*unique|SQLITE_CONSTRAINT_UNIQUE/i.test(databaseErrorMessage(error));
}
function isRetryableGoogleRace(error) {
    return isUniqueConstraintError(error)
        || /SQLITE_BUSY|database is locked|transaction.*(busy|conflict)|write conflict/i.test(databaseErrorMessage(error));
}
async function retryGoogleRace(work) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await work();
        }
        catch (error) {
            lastError = error;
            if (!isRetryableGoogleRace(error) || attempt === 2)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
    }
    throw lastError;
}
export function registerAuthRoutes(app, db, verifyGoogleCredential = defaultVerifyGoogleCredential) {
    // OAuth client IDs are public. Resolve this at runtime so the dashboard
    // does not also need a build-time copy of the backend setting.
    app.get("/auth/google/config", async (_request, reply) => {
        return reply.send({ clientId: env.GOOGLE_CLIENT_ID ?? null });
    });
    // Authentication intentionally creates only an account. The first workspace
    // and site are created by the required onboarding flow after sign-in.
    app.post("/auth/signup", async (request, reply) => {
        const parsed = signupSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        const { password, name } = parsed.data;
        const email = normalizeEmail(parsed.data.email);
        const passwordHash = await hashPassword(password);
        let result;
        try {
            result = await runInTransaction(db, async (tx) => {
                const [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
                if (existing)
                    return { error: "email_already_registered" };
                const [user] = await tx.insert(users).values({ email, passwordHash, name }).returning();
                const session = await issueSession(tx, user, env.JWT_SECRET);
                return { user, session };
            });
        }
        catch (error) {
            if (isUniqueConstraintError(error))
                return reply.code(409).send({ error: "email_already_registered" });
            throw error;
        }
        if ("error" in result)
            return reply.code(409).send({ error: result.error });
        return reply.code(201).send({
            user: { id: result.user.id, email: result.user.email, name: result.user.name },
            ...result.session,
        });
    });
    app.post("/auth/login", async (request, reply) => {
        const parsed = loginSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body" });
        }
        const email = normalizeEmail(parsed.data.email);
        const { password } = parsed.data;
        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        // Same error for "no such user" and "wrong password" - don't leak which emails are registered.
        if (!user || user.passwordHash === null || !(await verifyPassword(password, user.passwordHash))) {
            return reply.code(401).send({ error: "invalid_credentials" });
        }
        const session = await issueSession(db, user, env.JWT_SECRET);
        return reply.send({
            user: { id: user.id, email: user.email, name: user.name },
            ...session,
        });
    });
    app.post("/auth/google", async (request, reply) => {
        const parsed = googleSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body" });
        if (!env.GOOGLE_CLIENT_ID)
            return reply.code(503).send({ error: "google_auth_not_configured" });
        let googleIdentity;
        try {
            googleIdentity = await verifyGoogleCredential(parsed.data.credential, env.GOOGLE_CLIENT_ID);
        }
        catch {
            return reply.code(401).send({ error: "invalid_google_credential" });
        }
        if (!googleIdentity.subject || !googleIdentity.email) {
            return reply.code(401).send({ error: "invalid_google_credential" });
        }
        const email = normalizeEmail(googleIdentity.email);
        try {
            const result = await retryGoogleRace(() => runInTransaction(db, async (tx) => {
                const [linkedIdentity] = await tx
                    .select()
                    .from(userAuthIdentities)
                    .where(and(eq(userAuthIdentities.provider, "google"), eq(userAuthIdentities.providerSubject, googleIdentity.subject)))
                    .limit(1);
                if (linkedIdentity) {
                    const [linkedUser] = await tx.select().from(users).where(eq(users.id, linkedIdentity.userId)).limit(1);
                    if (!linkedUser)
                        throw new Error("linked user missing");
                    const session = await issueSession(tx, linkedUser, env.JWT_SECRET);
                    return { user: linkedUser, session };
                }
                const [emailUser] = await tx.select().from(users).where(sql `lower(${users.email}) = ${email}`).limit(1);
                if (emailUser) {
                    await tx.insert(userAuthIdentities).values({
                        userId: emailUser.id,
                        provider: "google",
                        providerSubject: googleIdentity.subject,
                        providerEmail: email,
                    }).onConflictDoNothing();
                    const [identityAfterInsert] = await tx
                        .select()
                        .from(userAuthIdentities)
                        .where(and(eq(userAuthIdentities.provider, "google"), eq(userAuthIdentities.providerSubject, googleIdentity.subject)))
                        .limit(1);
                    if (!identityAfterInsert)
                        return { error: "invalid_google_credential" };
                    const [canonicalUser] = await tx.select().from(users).where(eq(users.id, identityAfterInsert.userId)).limit(1);
                    if (!canonicalUser)
                        throw new Error("linked user missing");
                    const session = await issueSession(tx, canonicalUser, env.JWT_SECRET);
                    return { user: canonicalUser, session };
                }
                const userId = cuid("usr");
                const [user] = await tx.insert(users).values({
                    id: userId,
                    email,
                    passwordHash: null,
                    name: googleIdentity.name,
                }).returning();
                await tx.insert(userAuthIdentities).values({
                    userId,
                    provider: "google",
                    providerSubject: googleIdentity.subject,
                    providerEmail: email,
                });
                const session = await issueSession(tx, user, env.JWT_SECRET);
                return { user, session, created: true };
            }));
            if ("error" in result) {
                return reply.code(401).send({ error: result.error });
            }
            return reply.code(result.created ? 201 : 200).send({
                user: userJson(result.user),
                ...result.session,
            });
        }
        catch (error) {
            request.log.error({ err: error }, "Google authentication failed after credential verification");
            return reply.code(500).send({ error: "google_auth_failed" });
        }
    });
    app.get("/auth/onboarding", { preHandler: authenticate }, async (request, reply) => {
        const orgRows = await db.select().from(memberships).where(eq(memberships.userId, request.user.id));
        if (!orgRows.length)
            return reply.send({ complete: false, organization: null, site: null });
        const [organization] = await db.select().from(organizations).where(eq(organizations.id, orgRows[0].orgId)).limit(1);
        const orgSites = organization ? await db.select().from(sites).where(eq(sites.orgId, organization.id)) : [];
        const complete = Boolean(organization?.onboardingCompletedAt);
        return reply.send({ complete, organization: organization ? { id: organization.id, name: organization.name } : null, site: orgSites[0] ? { id: orgSites[0].id, siteId: orgSites[0].publicId, name: orgSites[0].name, domain: orgSites[0].domain } : null });
    });
    app.post("/auth/onboarding", { preHandler: authenticate }, async (request, reply) => {
        const parsed = onboardingSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const domain = parsed.data.domain;
        try {
            new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);
        }
        catch {
            return reply.code(400).send({ error: "invalid_domain" });
        }
        const result = await runInTransaction(db, async (tx) => {
            const existing = await tx.select().from(memberships).where(eq(memberships.userId, request.user.id)).limit(1);
            if (existing.length)
                return { error: "onboarding_already_started" };
            const [org] = await tx.insert(organizations).values({ name: parsed.data.workspaceName }).returning();
            await tx.insert(memberships).values({ userId: request.user.id, orgId: org.id, role: "OWNER" });
            await createGrowthTrial(tx, org.id);
            const [site] = await tx.insert(sites).values({ orgId: org.id, publicId: generateSitePublicId(), name: parsed.data.siteName, domain, publicConfig: {} }).returning();
            return { org, site };
        });
        if ("error" in result)
            return reply.code(409).send(result);
        return reply.code(201).send({ organization: { id: result.org.id, name: result.org.name }, site: { id: result.site.id, siteId: result.site.publicId, name: result.site.name, domain: result.site.domain } });
    });
    app.post("/auth/onboarding/skip", { preHandler: authenticate }, async (request, reply) => {
        const [membership] = await db.select().from(memberships).where(eq(memberships.userId, request.user.id)).limit(1);
        if (!membership)
            return reply.code(409).send({ error: "onboarding_not_started" });
        const now = new Date();
        await db.update(organizations).set({ onboardingCompletedAt: now, onboardingSkippedAt: now, updatedAt: now }).where(eq(organizations.id, membership.orgId));
        return reply.code(204).send();
    });
    // Refresh token rotation: every refresh both issues a new pair AND
    // revokes the token that was just used. A reused (already-revoked)
    // refresh token is treated as a signal the token was stolen - the
    // whole family isn't tracked in this first pass, but revoking on use
    // at least closes the replay window.
    app.post("/auth/refresh", async (request, reply) => {
        const parsed = refreshSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body" });
        }
        const tokenHash = hashRefreshToken(parsed.data.refreshToken);
        const result = await runInTransaction(db, async (tx) => {
            const [row] = await tx
                .select()
                .from(refreshTokens)
                .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
                .limit(1);
            if (!row || row.expiresAt.getTime() < Date.now())
                return { error: "invalid_refresh_token" };
            const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1);
            if (!user)
                return { error: "invalid_refresh_token" };
            const revoked = await tx.update(refreshTokens)
                .set({ revokedAt: new Date() })
                .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
                .returning({ id: refreshTokens.id });
            if (revoked.length !== 1)
                return { error: "invalid_refresh_token" };
            return { session: await issueSession(tx, user, env.JWT_SECRET) };
        });
        if ("error" in result)
            return reply.code(401).send({ error: result.error });
        return reply.send(result.session);
    });
    app.post("/auth/logout", async (request, reply) => {
        const parsed = refreshSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body" });
        }
        const tokenHash = hashRefreshToken(parsed.data.refreshToken);
        await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, tokenHash));
        return reply.code(204).send();
    });
    app.get("/auth/me", { preHandler: authenticate }, async (request, reply) => {
        const [user] = await db.select().from(users).where(eq(users.id, request.user.id)).limit(1);
        if (!user) {
            return reply.code(404).send({ error: "user_not_found" });
        }
        const memberRows = await db.select().from(memberships).where(eq(memberships.userId, user.id));
        return reply.send({
            user: { id: user.id, email: user.email, name: user.name },
            memberships: memberRows.map((m) => ({ orgId: m.orgId, role: m.role })),
        });
    });
}
//# sourceMappingURL=auth.js.map