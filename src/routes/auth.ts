import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users, organizations, memberships, refreshTokens } from "../db/schema.js";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from "../lib/auth.js";
import { authenticate } from "../middleware/authenticate.js";
import { env } from "../config.js";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, "password must be at least 10 characters"),
  orgName: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

function issueTokenPair(userId: string, email: string) {
  const accessToken = signAccessToken({ sub: userId, email }, env.JWT_SECRET);
  const refresh = generateRefreshToken();
  return { accessToken, refresh };
}

export function registerAuthRoutes(app: FastifyInstance, db: Db) {
  // One org is created per signup, with the signing-up user as OWNER.
  // Joining an *existing* org happens via the (separate, not-yet-built)
  // invite flow - signup always creates a new tenant boundary.
  app.post("/auth/signup", async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { email, password, orgName, name } = parsed.data;

    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      return reply.code(409).send({ error: "email_already_registered" });
    }

    const passwordHash = await hashPassword(password);

    const [user] = await db.insert(users).values({ email, passwordHash, name }).returning();
    const [org] = await db.insert(organizations).values({ name: orgName }).returning();
    await db.insert(memberships).values({ userId: user.id, orgId: org.id, role: "OWNER" });

    const { accessToken, refresh } = issueTokenPair(user.id, user.email);
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
    });

    return reply.code(201).send({
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: org.id, name: org.name },
      accessToken,
      refreshToken: refresh.token,
    });
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const { email, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    // Same error for "no such user" and "wrong password" - don't leak which emails are registered.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const { accessToken, refresh } = issueTokenPair(user.id, user.email);
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
    });

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name },
      accessToken,
      refreshToken: refresh.token,
    });
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

    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
      .limit(1);

    if (!row || row.expiresAt.getTime() < Date.now()) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }

    const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!user) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }

    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));

    const { accessToken, refresh } = issueTokenPair(user.id, user.email);
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
    });

    return reply.send({ accessToken, refreshToken: refresh.token });
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
    const [user] = await db.select().from(users).where(eq(users.id, request.user!.id)).limit(1);
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
