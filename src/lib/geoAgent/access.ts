import { createHmac, createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../config.js";
import type { Db } from "../../db/client.js";
import { sites, experiences, experienceVersions } from "../../db/schema.js";
import { getOrganizationSubscription, subscriptionIsActive } from "../entitlements/subscription.js";
import { matchesExperienceAudience } from "../experiences/audience.js";
import { geoAgentDefinitionSchema } from "../experiences/validation.js";
import { resolveDeliveryUserId } from "../identity/deliveryIdentity.js";
import { matchesRules } from "../pages/pageMatcher.js";

const audience = "movcues-geo-agent-runtime";
const signingKey = createHmac("sha256", env.JWT_SECRET).update("movcues/geo-agent/session/v1").digest();
const claimsSchema = z.object({
  sub: z.string().min(32).max(128),
  site: z.string(),
  widget: z.string(),
  version: z.string(),
  origin: z.string(),
  identity: z.string().max(200).optional(),
  exp: z.number(),
});
export type VisitorClaims = z.infer<typeof claimsSchema>;

function siteOrigin(domain: string | null) {
  if (!domain) return null;
  try { return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin; } catch { return null; }
}

export async function loadPublishedAgent(db: Db, publicId: string, widgetId: string, url: string, originHeader?: string) {
  const [row] = await db.select({ site: sites, experience: experiences, version: experienceVersions })
    .from(sites).innerJoin(experiences, eq(experiences.siteId, sites.id))
    .innerJoin(experienceVersions, and(eq(experienceVersions.id, experiences.publishedVersionId), eq(experienceVersions.experienceId, experiences.id)))
    .where(and(eq(sites.publicId, publicId), eq(experiences.id, widgetId), eq(experiences.widgetType, "geo_agent"),
      eq(experiences.status, "published"), eq(experienceVersions.state, "published"))).limit(1);
  if (!row || !originHeader || !subscriptionIsActive(await getOrganizationSubscription(db, row.site.orgId))) return null;
  const origin = siteOrigin(row.site.domain);
  const page = new URL(url);
  if (!origin || originHeader !== origin || page.origin !== origin) return null;
  const parsed = geoAgentDefinitionSchema.safeParse(row.version.definition);
  if (!parsed.success || !parsed.data.geoAgent.enabled || !parsed.data.geoAgent.showLauncher) return null;
  const targeting = parsed.data.targeting;
  const now = Date.now();
  if (targeting.schedule?.startsAt && now < Date.parse(targeting.schedule.startsAt)) return null;
  if (targeting.schedule?.endsAt && now >= Date.parse(targeting.schedule.endsAt)) return null;
  if (targeting.allowedOrigins?.length && !targeting.allowedOrigins.includes(origin)) return null;
  if (targeting.pageRules.length && !matchesRules(page.pathname + page.search + page.hash, targeting.pageRules)) return null;
  return { ...row, origin, definition: parsed.data };
}

export type PublishedGeoAgent = NonNullable<Awaited<ReturnType<typeof loadPublishedAgent>>>;

export function verifyCustomerIdentity(token: string, publicKey: string, sitePublicId: string) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[\w-]+$/.test(part))) return null;
    const [head, claims, signature] = parts;
    if (JSON.parse(Buffer.from(head, "base64url").toString()).alg !== "EdDSA") return null;
    if (!verify(null, Buffer.from(`${head}.${claims}`), createPublicKey(publicKey), Buffer.from(signature, "base64url"))) return null;
    const parsed = z.object({ iss: z.literal(sitePublicId), aud: z.literal("movcues-geo-agent"), sub: z.string().min(1).max(200), exp: z.number().int() })
      .parse(JSON.parse(Buffer.from(claims, "base64url").toString()));
    const now = Math.floor(Date.now() / 1000);
    return parsed.exp > now && parsed.exp <= now + 300 ? parsed.sub : null;
  } catch { return null; }
}

export function issueVisitorToken(agent: PublishedGeoAgent, identity?: string) {
  const sub = identity ? createHash("sha256").update(JSON.stringify([agent.site.id, identity])).digest("base64url")
    : randomBytes(32).toString("base64url");
  return jwt.sign({
    sub, site: agent.site.id, widget: agent.experience.id, version: agent.version.id, origin: agent.origin,
    ...(identity ? { identity } : {}),
  }, signingKey, { algorithm: "HS256", audience, expiresIn: identity ? "15m" : "8h" });
}

export function visitorClaims(authorization: string | undefined, agent: PublishedGeoAgent): VisitorClaims | null {
  if (!authorization?.startsWith("Bearer ") || authorization.length > 5000) return null;
  try {
    const result = claimsSchema.parse(jwt.verify(authorization.slice(7), signingKey, { algorithms: ["HS256"], audience }));
    return result.site === agent.site.id && result.widget === agent.experience.id && result.version === agent.version.id
      && result.origin === agent.origin ? result : null;
  } catch { return null; }
}

export async function visitorIsEligible(db: Db, agent: PublishedGeoAgent, identity?: string) {
  const audience = agent.definition.targeting.audience;
  if (audience.type === "all") return true;
  if (!identity) return false;
  const userId = await resolveDeliveryUserId(db, agent.site.id, identity);
  return userId !== null && matchesExperienceAudience(db, agent.site.id, userId, audience);
}
