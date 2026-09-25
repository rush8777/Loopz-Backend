import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  auditLogs,
  cuid,
  memberships,
  organizationInvitations,
  organizations,
  refreshTokens,
  users,
} from "../db/schema.js";
import { env } from "../config.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { generateRefreshToken, hashPassword, signAccessToken } from "../lib/auth.js";
import {
  generateInvitationToken,
  getInvitationStatus,
  hashInvitationToken,
  invitationUrl,
  normalizeEmail,
  type InvitationRole,
} from "../lib/invitations.js";

const invitationInputSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});

const invitationSignupSchema = z.object({
  name: z.string().trim().min(1).max(200),
  password: z.string().min(10, "password must be at least 10 characters"),
});

function invalidInvitation(reply: FastifyReply) {
  return reply.code(404).send({ error: "invalid_invitation" });
}

function invitationJson(invitation: typeof organizationInvitations.$inferSelect) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role as InvitationRole,
    status: getInvitationStatus(invitation),
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
  };
}

function findInvitationByToken(db: Db, token: string) {
  const tokenHash = hashInvitationToken(token);
  return db
    .select()
    .from(organizationInvitations)
    .where(eq(organizationInvitations.tokenHash, tokenHash))
    .limit(1);
}

function issueTokenPair(userId: string, email: string) {
  const accessToken = signAccessToken({ sub: userId, email }, env.JWT_SECRET);
  const refresh = generateRefreshToken();
  return { accessToken, refresh };
}

export function registerInvitationRoutes(app: FastifyInstance, db: Db) {
  app.get(
    "/orgs/:orgId/invitations",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const rows = await db
        .select()
        .from(organizationInvitations)
        .where(eq(organizationInvitations.orgId, request.membership!.orgId))
        .orderBy(desc(organizationInvitations.createdAt))
        .limit(50);
      return reply.send({ invitations: rows.map(invitationJson) });
    }
  );

  app.post(
    "/orgs/:orgId/invitations",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const parsed = invitationInputSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const orgId = request.membership!.orgId;
      const email = normalizeEmail(parsed.data.email);

      const [existingUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);
      if (existingUser) {
        const [existingMembership] = await db
          .select({ id: memberships.id })
          .from(memberships)
          .where(and(eq(memberships.userId, existingUser.id), eq(memberships.orgId, orgId)))
          .limit(1);
        if (existingMembership) return reply.code(409).send({ error: "already_a_member" });
      }

      const invitationRows = await db
        .select()
        .from(organizationInvitations)
        .where(and(eq(organizationInvitations.orgId, orgId), eq(organizationInvitations.email, email)));
      if (invitationRows.some((row) => getInvitationStatus(row) === "pending")) {
        return reply.code(409).send({ error: "invitation_already_pending" });
      }

      const token = generateInvitationToken();
      const [invitation] = await db
        .insert(organizationInvitations)
        .values({
          orgId,
          email,
          role: parsed.data.role,
          tokenHash: token.tokenHash,
          invitedByUserId: request.user!.id,
          expiresAt: token.expiresAt,
        })
        .returning();
      await db.insert(auditLogs).values({
        orgId,
        userId: request.user!.id,
        action: "member.invited",
        detail: { invitationId: invitation.id, email, role: invitation.role },
      });
      return reply.code(201).send({
        invitation: invitationJson(invitation),
        inviteUrl: invitationUrl(env.DASHBOARD_URL, token.token),
      });
    }
  );

  app.delete(
    "/orgs/:orgId/invitations/:invitationId",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      const orgId = request.membership!.orgId;
      const [invitation] = await db
        .select()
        .from(organizationInvitations)
        .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.orgId, orgId)))
        .limit(1);
      if (!invitation) return reply.code(404).send({ error: "invitation_not_found" });
      if (getInvitationStatus(invitation) !== "pending") {
        return reply.code(409).send({ error: "invitation_not_pending" });
      }
      await db
        .update(organizationInvitations)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(organizationInvitations.id, invitation.id));
      await db.insert(auditLogs).values({
        orgId,
        userId: request.user!.id,
        action: "member.invitation_revoked",
        detail: { invitationId: invitation.id, email: invitation.email },
      });
      return reply.code(204).send();
    }
  );

  app.post(
    "/orgs/:orgId/invitations/:invitationId/rotate",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      const orgId = request.membership!.orgId;
      const [invitation] = await db
        .select()
        .from(organizationInvitations)
        .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.orgId, orgId)))
        .limit(1);
      if (!invitation) return reply.code(404).send({ error: "invitation_not_found" });
      if (getInvitationStatus(invitation) !== "pending") {
        return reply.code(409).send({ error: "invitation_not_pending" });
      }
      const token = generateInvitationToken();
      const [updated] = await db
        .update(organizationInvitations)
        .set({ tokenHash: token.tokenHash, expiresAt: token.expiresAt, updatedAt: new Date() })
        .where(eq(organizationInvitations.id, invitation.id))
        .returning();
      await db.insert(auditLogs).values({
        orgId,
        userId: request.user!.id,
        action: "member.invitation_rotated",
        detail: { invitationId: invitation.id, email: invitation.email },
      });
      return reply.send({
        invitation: invitationJson(updated),
        inviteUrl: invitationUrl(env.DASHBOARD_URL, token.token),
      });
    }
  );

  app.get("/auth/invitations/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const [invitation] = await findInvitationByToken(db, token);
    if (!invitation || getInvitationStatus(invitation) !== "pending") return invalidInvitation(reply);
    const [organization] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, invitation.orgId))
      .limit(1);
    if (!organization) return invalidInvitation(reply);
    return reply.send({
      organization,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    });
  });

  app.post(
    "/auth/invitations/:token/accept",
    { preHandler: authenticate },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const [initial] = await findInvitationByToken(db, token);
      if (!initial || getInvitationStatus(initial) !== "pending") return invalidInvitation(reply);
      if (normalizeEmail(request.user!.email) !== initial.email) {
        return reply.code(403).send({ error: "invitation_email_mismatch", invitationEmail: initial.email });
      }

      const result = db.transaction((tx) => {
        const invitation = tx
          .select()
          .from(organizationInvitations)
          .where(eq(organizationInvitations.id, initial.id))
          .limit(1)
          .get();
        if (!invitation || getInvitationStatus(invitation) !== "pending") return { error: "invalid_invitation" as const };
        const membership = tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.userId, request.user!.id), eq(memberships.orgId, invitation.orgId)))
          .limit(1)
          .get();
        if (membership) return { error: "already_a_member" as const };
        const created = tx
          .insert(memberships)
          .values({ userId: request.user!.id, orgId: invitation.orgId, role: invitation.role })
          .returning()
          .get();
        const now = new Date();
        tx.update(organizationInvitations)
          .set({ acceptedAt: now, updatedAt: now })
          .where(and(eq(organizationInvitations.id, invitation.id), isNull(organizationInvitations.acceptedAt)))
          .run();
        tx.insert(auditLogs).values({
          orgId: invitation.orgId,
          userId: request.user!.id,
          action: "member.invitation_accepted",
          detail: { invitationId: invitation.id, role: invitation.role },
        }).run();
        return { membership: created };
      });
      if ("error" in result) {
        return result.error === "already_a_member"
          ? reply.code(409).send({ error: result.error })
          : invalidInvitation(reply);
      }
      return reply.send({
        membership: { orgId: result.membership.orgId, userId: result.membership.userId, role: result.membership.role },
      });
    }
  );

  app.post("/auth/invitations/:token/signup", async (request, reply) => {
    const parsed = invitationSignupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const { token } = request.params as { token: string };
    const [initial] = await findInvitationByToken(db, token);
    if (!initial || getInvitationStatus(initial) !== "pending") return invalidInvitation(reply);
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${initial.email}`)
      .limit(1);
    if (existingUser) return reply.code(409).send({ error: "account_exists_sign_in" });

    const passwordHash = await hashPassword(parsed.data.password);
    const userId = cuid("usr");
    const { accessToken, refresh } = issueTokenPair(userId, initial.email);
    const result = db.transaction((tx) => {
      const invitation = tx
        .select()
        .from(organizationInvitations)
        .where(eq(organizationInvitations.id, initial.id))
        .limit(1)
        .get();
      if (!invitation || getInvitationStatus(invitation) !== "pending") return { error: "invalid_invitation" as const };
      const existing = tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${invitation.email}`).limit(1).get();
      if (existing) return { error: "account_exists_sign_in" as const };
      const now = new Date();
      const user = tx
        .insert(users)
        .values({ id: userId, email: invitation.email, passwordHash, name: parsed.data.name })
        .returning()
        .get();
      const membership = tx
        .insert(memberships)
        .values({ userId, orgId: invitation.orgId, role: invitation.role })
        .returning()
        .get();
      tx.update(organizationInvitations)
        .set({ acceptedAt: now, updatedAt: now })
        .where(and(eq(organizationInvitations.id, invitation.id), isNull(organizationInvitations.acceptedAt)))
        .run();
      tx.insert(refreshTokens).values({ userId, tokenHash: refresh.hash, expiresAt: refresh.expiresAt }).run();
      tx.insert(auditLogs).values({
        orgId: invitation.orgId,
        userId,
        action: "member.invitation_accepted",
        detail: { invitationId: invitation.id, role: invitation.role },
      }).run();
      return { user, membership };
    });
    if ("error" in result) {
      return result.error === "account_exists_sign_in"
        ? reply.code(409).send({ error: result.error })
        : invalidInvitation(reply);
    }
    return reply.code(201).send({
      user: { id: result.user.id, email: result.user.email, name: result.user.name },
      membership: { orgId: result.membership.orgId, role: result.membership.role },
      accessToken,
      refreshToken: refresh.token,
    });
  });
}
