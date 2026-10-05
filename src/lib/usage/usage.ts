import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DbExecutor } from "../../db/client.js";
import {
  dashboards,
  experienceVersions,
  experiences,
  funnels,
  memberships,
  organizationInvitations,
  segments,
  sessionEvents,
  sites,
  users,
} from "../../db/schema.js";
import { definitionSchemaFor } from "../experiences/validation.js";
import type { ExperienceKind } from "../experiences/types.js";
import { normalizeEmail } from "../invitations.js";

/** A UTC calendar month. Keeping this explicit avoids server-timezone billing
 * boundaries and lets the eventual subscription layer select a billing month. */
export interface UsageMonth {
  year: number;
  month: number; // 1-12
}

export function monthBounds(month: UsageMonth): { start: Date; end: Date } {
  if (!Number.isInteger(month.year) || !Number.isInteger(month.month) || month.month < 1 || month.month > 12) {
    throw new Error("invalid_usage_month");
  }
  return {
    start: new Date(Date.UTC(month.year, month.month - 1, 1)),
    end: new Date(Date.UTC(month.year, month.month, 1)),
  };
}

/** Normalizes the single configured site domain to the origin a browser sends
 * in Origin. A site with no configured production domain is deliberately not
 * billable until an administrator configures one. */
export function productionOrigin(domain: string | null): string | null {
  if (!domain) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);
    return url.origin;
  } catch {
    return null;
  }
}

async function countRows(db: DbExecutor, table: SQLiteTable, where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(table).where(where);
  return Number(row?.count ?? 0);
}

/**
 * Billable MAU for one site and UTC billing month: one distinct identified
 * tracked user with at least one persisted event from the site's configured
 * production origin. Events without a trustworthy Origin are retained for
 * analytics but never billable. Identity resolution assigns pre-identify
 * anonymous event rows to the one tracked user, so they cannot add a second
 * MAU once identified.
 */
export async function getMonthlyActiveUsers(db: DbExecutor, siteId: string, month: UsageMonth): Promise<number> {
  const [site] = await db.select({ domain: sites.domain }).from(sites).where(eq(sites.id, siteId)).limit(1);
  const origin = productionOrigin(site?.domain ?? null);
  if (!origin) return 0;
  const { start, end } = monthBounds(month);
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${sessionEvents.trackedUserId})` })
    .from(sessionEvents)
    .where(and(
      eq(sessionEvents.siteId, siteId),
      eq(sessionEvents.origin, origin),
      isNotNull(sessionEvents.trackedUserId),
      gte(sessionEvents.timestamp, start),
      lt(sessionEvents.timestamp, end),
    ));
  return Number(row?.count ?? 0);
}

/** Active dashboard seats plus invitations that can still be accepted. A
 * membership wins over a pending invitation with the same email so malformed
 * legacy data cannot double-count a person. */
export async function getMemberUsage(db: DbExecutor, orgId: string, now = new Date()): Promise<number> {
  const [memberRows, invitationRows] = await Promise.all([
    db.select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, orgId)),
    db.select({ email: organizationInvitations.email })
      .from(organizationInvitations)
      .where(and(
        eq(organizationInvitations.orgId, orgId),
        isNull(organizationInvitations.acceptedAt),
        isNull(organizationInvitations.revokedAt),
        gt(organizationInvitations.expiresAt, now),
      )),
  ]);
  const memberEmails = new Set(memberRows.map((row) => normalizeEmail(row.email)));
  return memberRows.length + invitationRows.filter((row) => !memberEmails.has(normalizeEmail(row.email))).length;
}

export async function getSiteUsage(db: DbExecutor, orgId: string): Promise<number> {
  return countRows(db, sites, eq(sites.orgId, orgId));
}

export async function getDashboardUsage(db: DbExecutor, siteId: string): Promise<number> {
  return countRows(db, dashboards, eq(dashboards.siteId, siteId));
}

export async function getOrganizationDashboardUsage(db: DbExecutor, orgId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(dashboards)
    .innerJoin(sites, eq(dashboards.siteId, sites.id)).where(eq(sites.orgId, orgId));
  return Number(row?.count ?? 0);
}

export async function getSegmentUsage(db: DbExecutor, siteId: string): Promise<number> {
  return countRows(db, segments, eq(segments.siteId, siteId));
}

export async function getOrganizationSegmentUsage(db: DbExecutor, orgId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(segments)
    .innerJoin(sites, eq(segments.siteId, sites.id)).where(eq(sites.orgId, orgId));
  return Number(row?.count ?? 0);
}

export async function getFunnelUsage(db: DbExecutor, siteId: string): Promise<number> {
  return countRows(db, funnels, eq(funnels.siteId, siteId));
}

export async function getOrganizationFunnelUsage(db: DbExecutor, orgId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(funnels)
    .innerJoin(sites, eq(funnels.siteId, sites.id)).where(eq(sites.orgId, orgId));
  return Number(row?.count ?? 0);
}

/**
 * Counts capacity-reserving published experiences for a site. A row must be
 * currently marked published, point to a published version, and have a valid
 * stored definition. Future schedules count; an ended schedule does not.
 */
export async function getPublishedExperienceUsage(db: DbExecutor, siteId: string, now = new Date()): Promise<number> {
  const rows = await db.select().from(experiences).where(and(
    eq(experiences.siteId, siteId),
    eq(experiences.status, "published"),
    isNotNull(experiences.publishedVersionId),
  ));
  const ids = rows.flatMap((row) => row.publishedVersionId ? [row.publishedVersionId] : []);
  if (ids.length === 0) return 0;
  const versions = await db.select().from(experienceVersions).where(inArray(experienceVersions.id, ids));
  const versionById = new Map(versions.map((version) => [version.id, version]));
  let count = 0;
  for (const experience of rows) {
    const version = experience.publishedVersionId ? versionById.get(experience.publishedVersionId) : undefined;
    if (!version || version.experienceId !== experience.id || version.state !== "published") continue;
    const parsed = definitionSchemaFor(experience.kind as ExperienceKind, experience.widgetType).safeParse(version.definition);
    if (!parsed.success) continue;
    const endsAt = parsed.data.targeting.schedule?.endsAt;
    if (endsAt && new Date(endsAt) <= now) continue;
    count += 1;
  }
  return count;
}

export async function getOrganizationPublishedExperienceUsage(db: DbExecutor, orgId: string, now = new Date()): Promise<number> {
  const orgSites = await db.select({ id: sites.id }).from(sites).where(eq(sites.orgId, orgId));
  const counts = await Promise.all(orgSites.map(site => getPublishedExperienceUsage(db, site.id, now)));
  return counts.reduce((total, count) => total + count, 0);
}

export interface SiteUsage {
  siteId: string;
  monthlyActiveUsers: number;
  dashboards: number;
  segments: number;
  funnels: number;
  publishedExperiences: number;
}

/** Tenant-scoped resource measurements. MAU remains site-scoped because the
 * current tracked-user identity key is unique only within a site. */
export async function getSiteUsageSnapshot(db: DbExecutor, siteId: string, month: UsageMonth, now = new Date()): Promise<SiteUsage> {
  const [monthlyActiveUsers, dashboards, segments, funnels, publishedExperiences] = await Promise.all([
    getMonthlyActiveUsers(db, siteId, month),
    getDashboardUsage(db, siteId),
    getSegmentUsage(db, siteId),
    getFunnelUsage(db, siteId),
    getPublishedExperienceUsage(db, siteId, now),
  ]);
  return { siteId, monthlyActiveUsers, dashboards, segments, funnels, publishedExperiences };
}

export interface OrganizationUsage {
  sites: number;
  members: number;
  dashboards: number;
  segments: number;
  funnels: number;
  publishedExperiences: number;
  monthlyActiveUsers: number;
  monthlyActiveUsersBySite: Array<{ siteId: string; monthlyActiveUsers: number }>;
}

/** Organization MAU is explicitly the sum of site MAUs. This is not an
 * identity dedupe: the existing identity model is intentionally site-scoped. */
export async function getOrganizationUsage(db: DbExecutor, orgId: string, month: UsageMonth, now = new Date()): Promise<OrganizationUsage> {
  const orgSites = await db.select({ id: sites.id }).from(sites).where(eq(sites.orgId, orgId));
  const siteSnapshots = await Promise.all(orgSites.map((site) => getSiteUsageSnapshot(db, site.id, month, now)));
  const members = await getMemberUsage(db, orgId, now);
  return {
    sites: orgSites.length,
    members,
    dashboards: siteSnapshots.reduce((sum, site) => sum + site.dashboards, 0),
    segments: siteSnapshots.reduce((sum, site) => sum + site.segments, 0),
    funnels: siteSnapshots.reduce((sum, site) => sum + site.funnels, 0),
    publishedExperiences: siteSnapshots.reduce((sum, site) => sum + site.publishedExperiences, 0),
    monthlyActiveUsers: siteSnapshots.reduce((sum, site) => sum + site.monthlyActiveUsers, 0),
    monthlyActiveUsersBySite: siteSnapshots.map((site) => ({ siteId: site.siteId, monthlyActiveUsers: site.monthlyActiveUsers })),
  };
}
