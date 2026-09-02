import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
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
function cuid(prefix) {
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
        .default(sql `(unixepoch('now') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
});
export const users = sqliteTable("users", {
    id: text("id").primaryKey().$defaultFn(() => cuid("usr")),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    name: text("name"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
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
        .default(sql `(unixepoch('now') * 1000)`),
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
        .default(sql `(unixepoch('now') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
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
        .default(sql `(unixepoch('now') * 1000)`),
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
        .default(sql `(unixepoch('now') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
});
/**
 * Discovered recurring behavioral pattern candidates - see
 * `src/lib/analysis/patternObserver.ts`. Deliberately NOT stored in
 * the `patterns` table above: `patterns.steps` is a `PatternStep[]`
 * expressed in the live FSM matcher's verb vocabulary (enter | hover |
 * click | scroll_past, see `src/lib/patterns/types.ts`), and
 * `patterns.feedback` requires a human-facing message - neither fits a
 * pattern candidate, which is expressed in the broader behavioral-
 * token vocabulary (dwell/hesitation/element_approach/... have no
 * corresponding `PatternStepVerb`) and carries no feedback message,
 * since generating one would be the classification/insight work this
 * layer explicitly does not do yet. A future "promote a candidate to
 * an authored/discovered `patterns` row" step is what would eventually
 * bridge the two - not implemented here.
 *
 * `representativeSequence`/`similarity`/`quality` are stored as JSON,
 * matching the project's existing convention for structured,
 * still-evolving shapes (see `patterns.steps`/`patterns.feedback`
 * above, `behavioralEvents.evidence` below) - their shapes mirror
 * `PatternCandidate`'s `representativeSequence`/`similarity`/`quality`
 * fields exactly (`src/lib/analysis/patternObserver.ts`).
 * `occurrenceCount`/`uniqueSessionCount` are plain columns since
 * they're the fields most likely to be sorted/filtered on directly.
 *
 * `observePatterns()` is a pure recompute over a batch of episodes, not
 * an incremental/live process - a caller re-running observation later
 * is expected to upsert rather than blindly insert duplicates, hence
 * no additional bookkeeping (e.g. version/updatedAt) beyond `createdAt`
 * for this MVP pass.
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
    // { average, minimum, maximum } - see PatternCandidateSimilarityStats.
    similarity: text("similarity", { mode: "json" }).notNull(),
    // { frequencyScore, coverageScore, consistencyScore, recencyScore, overallScore } - see PatternCandidateQuality.
    quality: text("quality", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
});
/**
 * Evidence join table: which episodes were observed as members of
 * which pattern candidate - the "traceable back to its evidence"
 * requirement for `pattern_candidates`. Deliberately just the
 * relationship (no per-row similarity score column): the aggregated
 * `pattern_candidates.similarity` stats already answer "how similar
 * are the episodes" at the candidate level, and adding a `real`-typed
 * column here would be the first of its kind in this schema for
 * marginal benefit at this stage - can be added later if per-episode
 * similarity needs to be queried directly.
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
        .default(sql `(unixepoch('now') * 1000)`),
});
/**
 * Catalog of interactive elements discovered on a site - populated by
 * the SDK's ElementCrawler (a DOM scan on page load + route change,
 * independent of whether anyone has actually clicked/hovered a given
 * element) via `POST /public/sites/:siteId/elements`, and readable/
 * editable through the authenticated `/orgs/:orgId/sites/:siteId/elements`
 * routes for the Observe > Elements page.
 *
 * One row per distinct (siteId, selector) - enforced at the application
 * level (select-then-insert-or-update in the ingestion route, same
 * upsert style already used for pattern_match_states in
 * public-events.ts), not a DB-level composite unique constraint; this
 * table is small and low-frequency-write enough that the extra schema
 * machinery isn't worth it yet.
 *
 * `source`/`isIgnored` are what make this human-correctable rather than
 * purely heuristic: `source` starts `"crawl"` and becomes `"manual"`
 * once a person edits the label via the PATCH route, at which point
 * later crawls stop overwriting that label (see runObservation-adjacent
 * ingestion logic in routes/public-elements.ts). `isIgnored` lets a
 * user mark something as noise (a layout wrapper accidentally matching
 * the crawler's interactive-element query) without deleting its
 * history - future analysis work can filter on it.
 */
export const elementCatalog = sqliteTable("element_catalog", {
    id: text("id").primaryKey().$defaultFn(() => cuid("elc")),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    selector: text("selector").notNull(),
    tagName: text("tag_name").notNull(),
    label: text("label"),
    role: text("role"),
    source: text("source").notNull().default("crawl"), // "crawl" | "manual"
    isIgnored: integer("is_ignored", { mode: "boolean" }).notNull().default(false),
    seenCount: integer("seen_count").notNull().default(1),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
});
/**
 * Raw Page-path sightings for globally identified catalog elements.
 * PageDefinition ids are deliberately absent: current Page rules are
 * applied at read time so historical sightings reclassify immediately.
 */
export const elementPageSightings = sqliteTable("element_page_sightings", {
    id: text("id").primaryKey().$defaultFn(() => cuid("eps")),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    elementId: text("element_id")
        .notNull()
        .references(() => elementCatalog.id, { onDelete: "cascade" }),
    pagePath: text("page_path").notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    seenCount: integer("seen_count").notNull().default(1),
}, (table) => [
    uniqueIndex("element_page_sightings_site_element_path_uidx").on(table.siteId, table.elementId, table.pagePath),
    index("element_page_sightings_site_path_idx").on(table.siteId, table.pagePath),
]);
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
        .default(sql `(unixepoch('now') * 1000)`),
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
        .default(sql `(unixepoch('now') * 1000)`),
});
/**
 * A logical "Page" (Product Detail, Checkout, Settings, ...) defined
 * by URL-matching rules, in the Pendo Pages sense - NOT a raw URL.
 * `rules` is an ordered `PageRule[]` (see lib/pages/types.ts):
 * `{ id, kind: "include" | "exclude", operator, value }`. A URL
 * matches this Page when it matches no exclude rule and at least one
 * include rule - see lib/pages/pageMatcher.ts, the single place this
 * logic lives.
 *
 * Deliberately NOT a column on `session_events`: matching happens at
 * read time against the immutable `pagePath` already stored there
 * (see the eventId/pageViewId persistence work), the same way Pendo
 * re-matches raw events against current rules rather than baking a
 * pageId into the event at ingest time. Editing a Page's rules here
 * therefore reclassifies *historical* events too, on the next read -
 * nothing needs to be backfilled.
 */
export const pageDefinitions = sqliteTable("page_definitions", {
    id: text("id").primaryKey().$defaultFn(() => cuid("pgd")),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // Free-text grouping ("Commerce", "Account", ...) - Pendo calls this
    // Product Area. Optional; not enforced against a fixed vocabulary.
    area: text("area"),
    // Optional classification (dashboard | list | detail | settings |
    // checkout | landing | marketing | pricing | auth | docs | other) -
    // advisory metadata for the UI only, never used by the matcher.
    pageType: text("page_type"),
    rules: text("rules", { mode: "json" }).notNull(),
    heatmapEnabled: integer("heatmap_enabled", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
});
export const pageHeatmapStates = sqliteTable("page_heatmap_states", {
    id: text("id").primaryKey().$defaultFn(() => cuid("hms")),
    siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
    pageDefinitionId: text("page_definition_id").notNull().references(() => pageDefinitions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    selector: text("selector").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(sql `(unixepoch('now') * 1000)`),
}, (table) => [index("page_heatmap_states_site_page_idx").on(table.siteId, table.pageDefinitionId)]);
export const heatmapReferenceSnapshots = sqliteTable("heatmap_reference_snapshots", {
    id: text("id").primaryKey().$defaultFn(() => cuid("hmr")),
    siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
    pageDefinitionId: text("page_definition_id").notNull().references(() => pageDefinitions.id, { onDelete: "cascade" }),
    pageStateId: text("page_state_id").references(() => pageHeatmapStates.id, { onDelete: "cascade" }),
    pagePath: text("page_path").notNull(),
    deviceClass: text("device_class").notNull(),
    viewportWidth: integer("viewport_width").notNull(),
    viewportHeight: integer("viewport_height").notNull(),
    documentWidth: integer("document_width").notNull(),
    documentHeight: integer("document_height").notNull(),
    imageDataUrl: text("image_data_url").notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("heatmap_snapshots_page_state_device_idx").on(table.pageDefinitionId, table.pageStateId, table.deviceClass)]);
export const heatmapCaptureRequests = sqliteTable("heatmap_capture_requests", {
    id: text("id").primaryKey().$defaultFn(() => cuid("hcr")),
    token: text("token").notNull().unique().$defaultFn(() => cuid("hct")),
    siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
    pageDefinitionId: text("page_definition_id").notNull().references(() => pageDefinitions.id, { onDelete: "cascade" }),
    pageStateId: text("page_state_id").references(() => pageHeatmapStates.id, { onDelete: "cascade" }),
    deviceClass: text("device_class").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(sql `(unixepoch('now') * 1000)`),
});
/**
 * Derived/rebuildable behavioral episode segmentation - see
 * `src/lib/behavior/episodeSegmentation.ts`. Computed from
 * `session_events` (via `behavioralEvents` below), never the other way
 * around: dropping and recomputing this table from raw telemetry must
 * always be safe, so nothing else should treat it as a source of
 * truth. `startedAt`/`endedAt` bound the episode; `startReason`/
 * `endReason` record which boundary rule produced each edge
 * (page_enter | idle_gap | session_start | session_end).
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
        .default(sql `(unixepoch('now') * 1000)`),
});
/**
 * Derived/rebuildable normalized behavioral events - see
 * `src/lib/behavior/behaviorCompiler.ts`. One row per
 * `BehavioralEvent` produced by compiling a session's raw
 * `session_events` (noise-reduced/aggregated cursor+hover telemetry
 * merged with the direct discrete-action mappings). `episodeId` is
 * nullable because compilation can run before segmentation has
 * assigned an event to an episode.
 *
 * Never a source of truth: `session_events` remains the immutable raw
 * log, and this table must always be safely droppable and
 * recomputable from it. `element`/`evidence`/`sourceEventIds` are
 * stored as JSON, same convention as `patterns.steps` and
 * `sites.publicConfig` - their shape mirrors `ElementIdentity`,
 * `BehavioralEventEvidence`, and `BehavioralEvent.sourceEventIds`
 * respectively (see `src/lib/behavior/*.ts`), kept as JSON here rather
 * than normalized columns since those shapes are still evolving.
 */
export const behavioralEvents = sqliteTable("behavioral_events", {
    id: text("id").primaryKey().$defaultFn(() => cuid("bev")),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    episodeId: text("episode_id").references(() => episodes.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // BehavioralEventKind - see src/lib/behavior/behavioralEvent.ts
    category: text("category").notNull(), // discrete_action | intent_signal | derived_signal
    timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
    // ElementIdentity JSON, when the event has a target - see elementIdentity.ts. Null for page-level events (page_enter, scroll).
    element: text("element", { mode: "json" }),
    // Duration/magnitude, where applicable (hover_intent/dwell/hesitation durationMs, repeated_action/repeated_attention count). Kept as separate typed columns since these are queried/aggregated on directly, unlike the free-form evidence blob below.
    durationMs: integer("duration_ms"),
    count: integer("count"),
    // BehavioralEventEvidence JSON - why this signal fired (distanceMoved, numberOfDirectionChanges, sampleCount, etc). See behavioralEvent.ts.
    evidence: text("evidence", { mode: "json" }),
    // Ids of the session_events rows this was derived from, when known - see behaviorCompiler.ts's attachProvenance.
    sourceEventIds: text("source_event_ids", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
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
    // The SDK's durable anonymous visitor id for whoever generated this
    // event (see SessionManager.getAnonymousId()). Nullable because rows
    // ingested before this column existed never had one - the identity
    // layer (tracked_user_aliases) simply can't resolve those older rows
    // to a tracked user, which is an acceptable gap for a first pass.
    anonymousId: text("anonymous_id"),
    // The SDK-generated id for this specific event (AnalyticsEvent.eventId,
    // see core/Analytics.ts's buildAndEnqueue on the SDK side). This is
    // what makes public ingestion idempotent: a retried event/batch (the
    // Transport's at-least-once delivery, or a resend after a timeout
    // whose original request actually succeeded) carries the same
    // eventId, and the unique index below makes the repeat insert a
    // no-op instead of a duplicate row. Nullable for backward
    // compatibility with any client still on an older SDK build that
    // doesn't send one - those events simply aren't deduped, same
    // tradeoff already made for anonymousId above.
    eventId: text("event_id"),
    // The SDK's page-view lifecycle id active when this event was
    // captured (AnalyticsEvent.pageViewId - see SessionManager's
    // getPageViewId()/newPageView() on the SDK side). The SDK alone owns
    // when this advances (route change); this backend only ever persists
    // whatever value it's sent, never generates or mutates one. Nullable
    // for the same backward-compatibility reason as eventId/anonymousId.
    pageViewId: text("page_view_id"),
    type: text("type").notNull(), // page_view | hover | click | scroll | cursor | custom
    timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
    // Immutable raw PageContext.path. New SDKs send it for every event so
    // PageDefinition rules can classify heatmap interactions at read time;
    // older rows may only have it on their page_view event.
    pagePath: text("page_path"),
    selector: text("selector"), // ElementDescriptor.selector, if the event has a target
    // SDK-computed display metadata for the same element (ElementLabeler) -
    // purely for display; selector remains the sole identity/matching
    // mechanism throughout the behavioral pipeline (see
    // src/lib/behavior/elementIdentity.ts's identity-vs-display note).
    elementLabel: text("element_label"),
    elementRole: text("element_role"),
    durationMs: integer("duration_ms"), // hover events
    scrollPercent: integer("scroll_percent"), // scroll events
    // Legacy viewport coordinates plus document-space heatmap coordinates.
    // Both frames and their dimensions remain available for compatibility;
    // Page heatmaps align primarily with documentX/documentY.
    x: integer("x"),
    y: integer("y"),
    viewportWidth: integer("viewport_width"),
    viewportHeight: integer("viewport_height"),
    documentX: integer("document_x"),
    documentY: integer("document_y"),
    documentWidth: integer("document_width"),
    documentHeight: integer("document_height"),
    deviceClass: text("device_class"),
    heatmapStateId: text("heatmap_state_id"),
    rageClickCount: integer("rage_click_count"),
    // Developer-defined custom events (analytics.event(name, properties?),
    // type === "custom" only). `eventName` is the caller's chosen event
    // name ("checkout_completed") - kept as its own indexable-by-value
    // column, distinct from `type`, so "which custom events happened"
    // stays queryable without parsing JSON. `eventProperties` is the
    // caller's arbitrary JSON-serializable properties object, stored
    // opaquely: this is deliberately NOT flattened into dedicated
    // columns (property names/shapes are per-customer and unbounded, the
    // same reasoning as identify()'s traits - see resolveIdentity.ts).
    // Both null for every non-custom event type.
    eventName: text("event_name"),
    eventProperties: text("event_properties", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
}, (table) => [
    // Scoped to site (not global) - the SDK's eventId is only guaranteed
    // unique within its own generation process, and different sites are
    // different customers' independent event streams. NULLs (pre-eventId
    // rows/older SDK builds) are not unique-constrained against each
    // other under SQLite's default unique-index semantics, which is the
    // desired behavior - see the eventId column comment above.
    uniqueIndex("session_events_site_event_unique").on(table.siteId, table.eventId),
    // Covers the Event Explorer's query shape end to end: the catalog
    // query (WHERE site_id=? AND type='custom' GROUP BY event_name),
    // and the detail/occurrences/timeseries queries (WHERE site_id=?
    // AND type='custom' AND event_name=? [AND timestamp BETWEEN ...]
    // ORDER BY timestamp) both match this index's column order as a
    // prefix, including satisfying the ORDER BY without a separate
    // sort. Not scoped to type='custom' only (SQLite doesn't support
    // partial indexes via Drizzle's sqliteTable API used elsewhere in
    // this file) - the leading (site_id, type) columns already keep it
    // useful for any other type-scoped query, not just custom events.
    index("session_events_site_type_name_ts_idx").on(table.siteId, table.type, table.eventName, table.timestamp),
]);
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
        .default(sql `(unixepoch('now') * 1000)`),
});
/**
 * User Profile / User 360 layer.
 *
 * A second identity domain, deliberately never sharing a namespace with
 * the dashboard's `users`/`memberships`/`organizations` (see the note
 * at the top of this file): these rows represent visitors/users of the
 * *customer's* site, identified via the SDK's `analytics.identify()`,
 * not people who log into Loopz.
 *
 * This is a read/aggregation layer over the existing behavioral
 * system, not a parallel collector - `tracked_users` and
 * `tracked_user_properties` are the only durable state it owns.
 * Activity, sessions, and derived stats (session_count, page_view_count,
 * first_page, etc.) are computed at query time from the existing
 * `session_events` log via `tracked_user_aliases`, never duplicated
 * into their own tables. See src/lib/identity/*.ts.
 */
/**
 * One row per end-user identity, scoped to a site. Uniqueness is
 * (siteId, externalUserId) - the customer's own user id is only
 * meaningful within their site, never assumed globally unique (see
 * the site-isolation requirement in the task brief).
 */
export const trackedUsers = sqliteTable("tracked_users", {
    id: text("id").primaryKey().$defaultFn(() => cuid("tru")),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    // The id the customer's app passes to identify(userId, attributes).
    externalUserId: text("external_user_id").notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    firstIdentifiedAt: integer("first_identified_at", { mode: "timestamp_ms" }).notNull(),
    lastIdentifiedAt: integer("last_identified_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
}, (table) => [uniqueIndex("tracked_users_site_external_unique").on(table.siteId, table.externalUserId)]);
/**
 * anonymousId -> tracked_user resolution. This is what lets a
 * profile's activity/sessions include everything a visitor did
 * *before* they were identified: every session_events row already
 * carries an anonymousId, so "which sessions belong to this tracked
 * user" is answered by joining through this table rather than
 * rewriting/duplicating historical events (see task brief section 4).
 *
 * Uniqueness is (siteId, anonymousId): one anonymous id resolves to at
 * most one tracked user per site at any given time. If the same
 * anonymousId is later identify()'d as a *different* externalUserId
 * (shared device, logout/login as someone else), the existing row is
 * re-pointed rather than duplicated - see resolveIdentity.ts.
 */
export const trackedUserAliases = sqliteTable("tracked_user_aliases", {
    id: text("id").primaryKey().$defaultFn(() => cuid("tua")),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    trackedUserId: text("tracked_user_id")
        .notNull()
        .references(() => trackedUsers.id, { onDelete: "cascade" }),
    anonymousId: text("anonymous_id").notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
}, (table) => [uniqueIndex("tracked_user_aliases_site_anon_unique").on(table.siteId, table.anonymousId)]);
/**
 * Explicit user properties, sourced from identify()'s `attributes`.
 * Dynamic by design - no hard-coded `plan`/`role`/`email` columns, see
 * task brief section 5. One row per (trackedUserId, name): the current
 * value is what's stored (last write wins), `firstSeenAt` is preserved
 * across updates so "when did we first learn this property" survives
 * value changes - this is deliberately NOT a full property-history
 * table (every change overwriting the same row), matching the brief's
 * "keep MVP focused" instruction in section 6.
 */
export const trackedUserProperties = sqliteTable("tracked_user_properties", {
    id: text("id").primaryKey().$defaultFn(() => cuid("tup")),
    trackedUserId: text("tracked_user_id")
        .notNull()
        .references(() => trackedUsers.id, { onDelete: "cascade" }),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Stored as its string representation regardless of valueType -
    // sqlite has no JSON/variant column type, and every value here
    // came from a JSON-serializable identify() trait to begin with.
    // valueType lets the API/UI coerce it back for display/filtering.
    value: text("value").notNull(),
    valueType: text("value_type").notNull(), // string | number | boolean | null | object
    source: text("source").notNull().default("identify"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
}, (table) => [uniqueIndex("tracked_user_properties_user_name_unique").on(table.trackedUserId, table.name)]);
/**
 * Automatically-collected environment context (device/browser/OS/
 * language/timezone/screen/referrer) for one session - one row per
 * session, not per event, since none of this changes mid-session. Sent
 * by the SDK as a dedicated "session_start" event the first time a
 * session is touched (see EnvironmentContext.ts / SessionManager.ts on
 * the SDK side).
 *
 * Deliberately its own table rather than columns on session_events:
 * session_events is a per-interaction log (many rows per session), so
 * putting mostly-static, one-per-session fields there would mean
 * either repeating them on every row or leaving them null on all but
 * one - a dedicated table keyed by (siteId, sessionId) gives O(1)
 * lookup for "what device was this session on" without scanning.
 */
export const sessionContexts = sqliteTable("session_contexts", {
    id: text("id").primaryKey().$defaultFn(() => cuid("sctx")),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    // Carried alongside sessionId (not just derivable by joining
    // session_events) so a session_context row is self-sufficient for
    // identity-layer joins - see getLatestEnvironmentContext.
    anonymousId: text("anonymous_id").notNull(),
    browserName: text("browser_name"),
    browserVersion: text("browser_version"),
    osName: text("os_name"),
    osVersion: text("os_version"),
    deviceType: text("device_type"), // desktop | mobile | tablet
    language: text("language"),
    timezone: text("timezone"),
    screenWidth: integer("screen_width"),
    screenHeight: integer("screen_height"),
    referrer: text("referrer"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
}, (table) => [uniqueIndex("session_contexts_site_session_unique").on(table.siteId, table.sessionId)]);
/**
 * Segments (task brief: Build Segments V1). A segment is a *saved
 * definition*, not a saved membership list - see the module doc
 * comment in src/lib/segments/evaluator.ts for why. `definition` is a
 * SegmentGroup (src/lib/segments/types.ts): a JSON tree of nested
 * AND/OR groups over event/user_property/page conditions, validated
 * at the API boundary (src/lib/segments/validation.ts) before it ever
 * reaches this column - same "structured JSON, validated at the
 * boundary, not flattened into columns" precedent as
 * `patterns.steps`/`page_definitions.rules` above.
 *
 * Deliberately no `segment_members` table for V1 (task brief section
 * 7): membership is always computed fresh from `definition` against
 * current session_events/tracked_user_properties/page_definitions
 * data by the evaluator, so a user's membership reflects their
 * current behavior rather than a snapshot that can go stale.
 */
export const segments = sqliteTable("segments", {
    id: text("id").primaryKey().$defaultFn(() => cuid("seg")),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    definition: text("definition", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
}, (table) => [
    // Segments list is scoped by site and searched/sorted by name -
    // matches the query shape in routes/segments.ts's list endpoint.
    index("segments_site_name_idx").on(table.siteId, table.name),
]);
/**
 * Funnels (task brief: Build Funnels V1). `steps` is an ordered JSON
 * array of FunnelStep (src/lib/funnels/types.ts) - event or page
 * steps, validated at the boundary (src/lib/funnels/validation.ts)
 * before it reaches this column, same precedent as `segments.definition`
 * above. `conversionWindowMinutes` is the funnel-level max time from
 * the first step to any later step (task brief section 9) - stored as
 * a plain integer rather than a `{value, unit}` JSON blob since it's a
 * single scalar the evaluator needs directly in query math.
 *
 * No `funnel_results` table (task brief section 22): conversion
 * numbers are always derived from current session_events/page data by
 * the evaluator (src/lib/funnels/evaluator.ts), same "definition
 * persists, analytics is derived" precedent as Segments.
 *
 * Deliberately no `segment_id` column here - task brief section 17's
 * segment filter is an analysis-time parameter (like the date range),
 * not a saved part of the funnel definition; see routes/funnels.ts's
 * `/analyze` and `/steps/:stepIndex/users` endpoints.
 */
export const funnels = sqliteTable("funnels", {
    id: text("id").primaryKey().$defaultFn(() => cuid("fun")),
    siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    steps: text("steps", { mode: "json" }).notNull(),
    conversionWindowMinutes: integer("conversion_window_minutes").notNull().default(1440), // 24h default - task brief section 9's "sensible V1 default"
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(sql `(unixepoch('now') * 1000)`),
}, (table) => [index("funnels_site_name_idx").on(table.siteId, table.name)]);
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
        .default(sql `(unixepoch('now') * 1000)`),
});
//# sourceMappingURL=schema.js.map