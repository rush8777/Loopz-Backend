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
 * In-progress match attempts, one row per (pattern, session). This is
 * what makes matching "live" across incremental event batches without
 * holding a session's full event history in memory or in the DB -
 * only this small state needs to survive between calls to the public
 * events endpoint. Terminal rows (matched/expired) are left in place as
 * a natural log rather than deleted; a cleanup job can prune old
 * expired/matched rows later if table size becomes a concern.
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
 * Durable raw event log, keyed by site + session. This is what the live
 * matcher tables deliberately do NOT provide (pattern_match_states only
 * keeps enough state to advance an FSM, not the full history) - batch
 * analysis (clustering, feature extraction, fuzzy sequence similarity)
 * needs the actual event history per session, so it gets its own table.
 *
 * Scaling note: this grows without bound as-is. A real deployment would
 * need a retention window (e.g. drop raw events after N days once
 * derived features/clusters are computed) or a move to a
 * columnar/time-series store - noted here rather than solved, since
 * it's not required to prove the analysis pipeline out.
 */
export const sessionEvents = sqliteTable("session_events", {
  id: text("id").primaryKey().$defaultFn(() => cuid("evt")),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  type: text("type").notNull(), // page_view | hover | click | scroll | cursor
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
  selector: text("selector"), // ElementDescriptor.selector, if the event has a target
  durationMs: integer("duration_ms"), // hover events
  scrollPercent: integer("scroll_percent"), // scroll events
  // Coordinates for spatial analysis (heatmaps) - click/hover/cursor
  // events only. Stored alongside the viewport size active at capture
  // time so the dashboard can normalize to relative page position
  // across visitors on different screen sizes.
  x: integer("x"),
  y: integer("y"),
  viewportWidth: integer("viewport_width"),
  viewportHeight: integer("viewport_height"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});

/**
 * Raw rrweb events for session replay, one row per event, ordered by
 * `seq`. Stored exactly as the SDK's RRWebRecorder emits them (see
 * SessionReplayEvent in the SDK) - this backend never interprets rrweb
 * semantics, it's purely a durable log for playback and for the
 * dashboard to pull a FullSnapshot (rrweb event type 2) out of to
 * render a static screenshot for heatmap overlays.
 *
 * Simplification worth flagging: keyed by the SDK's regular
 * `sessionId`, not rrweb's own `replaySessionId` - the dashboard's unit
 * of "a session" is the analytics session, so replay data is filed
 * under that for easy correlation with the rest of a session's events,
 * even though the SDK generates a separate replaySessionId internally.
 */
export const sessionReplayEvents = sqliteTable("session_replay_events", {
  id: text("id").primaryKey().$defaultFn(() => cuid("rrw")),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  rrwebType: integer("rrweb_type").notNull(), // rrweb's own numeric event type (2 = FullSnapshot, etc.)
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
  data: text("data", { mode: "json" }).notNull(), // the raw rrweb event, unmodified
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
  action: text("action").notNull(), // e.g. "site.created", "member.invited"
  detail: text("detail", { mode: "json" }).notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('now') * 1000)`),
});
