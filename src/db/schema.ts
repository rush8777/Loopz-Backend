import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Auth + tenancy foundation.
 *
 * Two identity models live side by side, deliberately never sharing a
 * namespace:
 *   - Dashboard identity: users <-> memberships <-> organizations, real
 *     credentialed auth, scoped by orgId.
 *   - End-user identity: NOT modeled here at all. anonymousId/sessionId
 *     live entirely in the SDK's event stream (a separate analytics
 *     database), scoped by siteId. This schema only owns the `sites`
 *     row itself (the tenant boundary siteId resolves to), never the
 *     visitors it tracks.
 */

function cuid(prefix: string): string {
  // Lightweight sortable unique id, not a real cuid2 impl - good enough
  // for a first pass. Swap for `@paralleldrive/cuid2` if collision
  // resistance under high write concurrency becomes a real concern.
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
export { cuid };

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey().$defaultFn(() => cuid("org")),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => cuid("usr")),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/** Which orgs a user belongs to, and their role in each. A user can belong to multiple orgs. */
export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey().$defaultFn(() => cuid("mem")),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  // OWNER | ADMIN | MEMBER | VIEWER - enforced at the application layer,
  // see src/lib/roles.ts, rather than a DB-level enum (sqlite has none).
  role: text("role").notNull().default("MEMBER"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * One site = one tracked property = one `siteId` the SDK is configured
 * with. publicId is what actually ships in customer-facing SDK config
 * and URLs - deliberately not the internal primary key, so it can be
 * rotated/regenerated without changing the row's identity.
 */
export const sites = sqliteTable("sites", {
  id: text("id").primaryKey().$defaultFn(() => cuid("site")),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  domain: text("domain"),
  // Non-sensitive config served by the public, unauthenticated config
  // endpoint the SDK calls at runtime. Never put secrets in here - this
  // JSON blob is readable by anyone who knows the siteId.
  publicConfig: text("public_config", { mode: "json" }).notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Refresh token rotation for dashboard sessions. Access tokens are
 * short-lived JWTs (never stored); refresh tokens are stored hashed so
 * a DB read alone can't be used to mint sessions.
 */
export const refreshTokens = sqliteTable("refresh_tokens", {
  id: text("id").primaryKey().$defaultFn(() => cuid("rtk")),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Pattern registry - the shared format both authored and (once promoted)
 * discovered patterns compile into. `definition` and `feedback` mirror
 * PatternDefinition/feedback from src/lib/patterns/types.ts; stored as
 * JSON here rather than normalized columns since the step schema is
 * still evolving and the matcher only ever needs it as a whole object.
 */
export const patterns = sqliteTable("patterns", {
  id: text("id").primaryKey().$defaultFn(() => cuid("ptn")),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  origin: text("origin").notNull().default("AUTHORED"), // AUTHORED | DISCOVERED
  status: text("status").notNull().default("DRAFT"), // DRAFT | ACTIVE | PAUSED
  matchWindowMs: integer("match_window_ms").notNull(),
  steps: text("steps", { mode: "json" }).notNull(),
  feedback: text("feedback", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Discovered recurring behavioral pattern candidates - see
 * `src/lib/analysis/patternObserver.ts`.
 */
export const patternCandidates = sqliteTable("pattern_candidates", {
  id: text("id").primaryKey().$defaultFn(() => cuid("pcd")),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  representativeSequence: text("representative_sequence", { mode: "json" }).notNull(),
  occurrenceCount: integer("occurrence_count").notNull(),
  uniqueSessionCount: integer("unique_session_count").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  similarity: text("similarity", { mode: "json" }).notNull(),
  quality: text("quality", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Derived/rebuildable behavioral episode segmentation - see
 * `src/lib/behavior/episodeSegmentation.ts`.
 */
export const episodes = sqliteTable("episodes", {
  id: text("id").primaryKey().$defaultFn(() => cuid("epi")),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }).notNull(),
  startReason: text("start_reason").notNull(), // page_enter | idle_gap | session_start
  endReason: text("end_reason").notNull(), // page_enter | idle_gap | session_end
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Evidence join table: which episodes were observed as members of
 * which pattern candidate.
 */
export const patternEpisodes = sqliteTable("pattern_episodes", {
  id: text("id").primaryKey().$defaultFn(() => cuid("pep")),
  patternCandidateId: text("pattern_candidate_id")
    .notNull()
    .references(() => patternCandidates.id, { onDelete: "cascade" }),
  episodeId: text("episode_id")
    .notNull()
    .references(() => episodes.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * In-progress match attempts, one row per (pattern, session).
 */
export const patternMatchStates = sqliteTable("pattern_match_states", {
  id: text("id").primaryKey().$defaultFn(() => cuid("pms")),
  patternId: text("pattern_id")
    .notNull()
    .references(() => patterns.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  cursor: integer("cursor").notNull().default(0),
  matchedSteps: text("matched_steps", { mode: "json" }).notNull().default("[]"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  lastMatchedAt: integer("last_matched_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("pending"), // pending | in_progress | matched | expired
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/** Immutable log of completed matches - one row per trigger that actually fired. */
export const patternMatches = sqliteTable("pattern_matches", {
  id: text("id").primaryKey().$defaultFn(() => cuid("pmt")),
  patternId: text("pattern_id")
    .notNull()
    .references(() => patterns.id, { onDelete: "cascade" }),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  matchedAt: integer("matched_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Derived/rebuildable normalized behavioral events - see
 * `src/lib/behavior/behaviorCompiler.ts`.
 */
export const behavioralEvents = sqliteTable("behavioral_events", {
  id: text("id").primaryKey().$defaultFn(() => cuid("bev")),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  episodeId: text("episode_id").references(() => episodes.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  category: text("category").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
  element: text("element", { mode: "json" }),
  durationMs: integer("duration_ms"),
  count: integer("count"),
  evidence: text("evidence", { mode: "json" }),
  sourceEventIds: text("source_event_ids", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Durable raw event log, keyed by site + session.
 */
export const sessionEvents = sqliteTable("session_events", {
  id: text("id").primaryKey().$defaultFn(() => cuid("evt")),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  type: text("type").notNull(), // page_view | hover | click | scroll | cursor
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
  selector: text("selector"),
  durationMs: integer("duration_ms"),
  scrollPercent: integer("scroll_percent"),
  x: integer("x"),
  y: integer("y"),
  viewportWidth: integer("viewport_width"),
  viewportHeight: integer("viewport_height"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Raw rrweb events for session replay, one row per event, ordered by `seq`.
 */
export const sessionReplayEvents = sqliteTable("session_replay_events", {
  id: text("id").primaryKey().$defaultFn(() => cuid("rrw")),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  rrwebType: integer("rrweb_type").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
  data: text("data", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Minimal audit trail - who did what, scoped to an org.
 */
export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey().$defaultFn(() => cuid("aud")),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  detail: text("detail", { mode: "json" }).notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});