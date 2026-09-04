import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { experienceEditorSessions, experiences, experienceVersions, pageDefinitions, segments, sites } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { createExperienceSchema, definitionSchemaFor, updateDraftSchema } from "../lib/experiences/validation.js";
async function loadSiteInOrg(db, siteId, orgId) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    return site?.orgId === orgId ? site : null;
}
async function loadExperience(db, siteId, experienceId) {
    const [row] = await db.select().from(experiences).where(eq(experiences.id, experienceId)).limit(1);
    return row?.siteId === siteId ? row : null;
}
function siteOrigin(domain) {
    if (!domain)
        return null;
    try {
        return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin;
    }
    catch {
        return null;
    }
}
function urlBelongsToSite(url, domain) {
    const origin = siteOrigin(domain);
    if (!origin)
        return false;
    try {
        return new URL(url).origin === origin;
    }
    catch {
        return false;
    }
}
function deriveBuildUrl(domain, rules) {
    const origin = siteOrigin(domain);
    if (!origin)
        return null;
    const rule = rules.find((item) => item.kind === "include");
    if (!rule)
        return origin;
    const path = rule.value.replace(/\*/g, "").trim();
    return new URL(path.startsWith("/") ? path : "/", origin).toString();
}
const DEFAULT_DESIGN = {
    width: "md",
    theme: { background: "#ffffff", foreground: "#111827", primary: "#2563eb", borderRadius: "md" },
};
function targeting(pageRules) {
    return { pageRules, audience: { type: "all" }, trigger: { type: "page_load" }, frequency: { mode: "once" }, priority: 0 };
}
function initialDefinition(kind, widgetType, pageRules) {
    const content = { heading: kind === "guide" ? "Welcome" : "A helpful message", body: "Add a concise message for your visitors." };
    if (kind === "guide") {
        return { steps: [{ id: "step_1", content, behavior: { placement: "auto", alignment: "center", offset: 8, dismissible: true } }], design: DEFAULT_DESIGN, targeting: targeting(pageRules) };
    }
    return {
        content,
        design: DEFAULT_DESIGN,
        behavior: {
            dismissible: true,
            ...(widgetType === "toast" ? { toastPosition: "bottom-right", autoDismissMs: null } : {}),
            ...(widgetType === "cursor_follow" ? { cursorOffset: { x: 16, y: 16 } } : {}),
            ...(widgetType === "anchored_card" || widgetType === "hotspot" ? { placement: "auto", alignment: "center", offset: 8 } : {}),
            ...(widgetType === "modal" ? { modalLayout: "center", backdrop: true, backdropOpacity: 0.45, closeOnBackdrop: false } : {}),
            ...(widgetType === "slideout" ? { slideoutPosition: "bottom-right", backdrop: false, backdropOpacity: 0.35, closeOnBackdrop: false } : {}),
            ...(widgetType === "banner" ? { bannerPosition: "top" } : {}),
            ...(widgetType === "hotspot" ? { hotspotStyle: "pulse", hotspotColor: DEFAULT_DESIGN.theme.primary } : {}),
        },
        targeting: targeting(pageRules),
    };
}
async function serializeExperience(db, row) {
    const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, row.id)).orderBy(desc(experienceVersions.versionNumber));
    const draft = versions.find((version) => version.state === "draft") ?? null;
    const published = versions.find((version) => version.id === row.publishedVersionId) ?? null;
    return {
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        draftVersion: draft ? { ...draft, definition: draft.definition, createdAt: draft.createdAt.toISOString(), publishedAt: null } : null,
        publishedVersion: published ? { ...published, definition: published.definition, createdAt: published.createdAt.toISOString(), publishedAt: published.publishedAt?.toISOString() ?? null } : null,
    };
}
async function validateReferences(db, siteId, definition) {
    for (const rule of definition.targeting.pageRules) {
        if (!rule.value.trim())
            return "invalid_page_targeting";
    }
    if (definition.targeting.pageRules.length > 0 && !definition.targeting.pageRules.some((rule) => rule.kind === "include"))
        return "invalid_page_targeting";
    const audience = definition.targeting.audience;
    const segmentIds = audience.type === "segment" ? [audience.segmentId] : audience.type === "segment_rules" ? audience.conditions.map(condition => condition.segmentId) : [];
    for (const segmentId of segmentIds) {
        const [segment] = await db.select().from(segments).where(eq(segments.id, segmentId)).limit(1);
        if (!segment || segment.siteId !== siteId)
            return "invalid_segment";
    }
    return null;
}
function validatePublishRequirements(kind, widgetType, definition) {
    if (kind === "guide") {
        if (!("steps" in definition) || definition.steps.some((step) => !step.target))
            return "target_required";
    }
    else if ((widgetType === "anchored_card" || widgetType === "hotspot") && (!("content" in definition) || !definition.target)) {
        return "target_required";
    }
    return null;
}
export function registerExperienceRoutes(app, db) {
    app.get("/orgs/:orgId/sites/:siteId/experiences", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const kind = request.query.kind;
        if (kind && kind !== "guide" && kind !== "widget")
            return reply.code(400).send({ error: "invalid_kind" });
        const rows = await db.select().from(experiences).where(eq(experiences.siteId, site.id)).orderBy(desc(experiences.updatedAt));
        const filtered = kind ? rows.filter((row) => row.kind === kind) : rows;
        return reply.send({ experiences: await Promise.all(filtered.map((row) => serializeExperience(db, row))) });
    });
    app.post("/orgs/:orgId/sites/:siteId/experiences", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const parsed = createExperienceSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        let page = null;
        if (parsed.data.buildPageId) {
            [page] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, parsed.data.buildPageId)).limit(1);
            if (!page || page.siteId !== site.id)
                return reply.code(400).send({ error: "invalid_build_page" });
        }
        const buildUrl = parsed.data.buildUrl ?? (page ? deriveBuildUrl(site.domain, page.rules) : null);
        if (!buildUrl || !urlBelongsToSite(buildUrl, site.domain))
            return reply.code(400).send({ error: "build_url_outside_site_domain" });
        const initialPageRules = parsed.data.useBuildPageAsTarget
            ? page
                ? page.rules
                : [{ id: "build_page", kind: "include", operator: "equals", value: new URL(buildUrl).pathname }]
            : [];
        const definition = initialDefinition(parsed.data.kind, parsed.data.widgetType ?? null, initialPageRules);
        const [experience] = await db.insert(experiences).values({
            siteId: site.id,
            kind: parsed.data.kind,
            widgetType: parsed.data.kind === "widget" ? parsed.data.widgetType : null,
            name: parsed.data.name,
            buildPageId: page?.id ?? null,
            buildUrl,
            createdBy: request.user.id,
        }).returning();
        await db.insert(experienceVersions).values({ experienceId: experience.id, versionNumber: 1, state: "draft", definition, createdBy: request.user.id });
        return reply.code(201).send(await serializeExperience(db, experience));
    });
    app.get("/orgs/:orgId/sites/:siteId/experiences/:experienceId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, experienceId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const row = await loadExperience(db, site.id, experienceId);
        if (!row)
            return reply.code(404).send({ error: "experience_not_found" });
        return reply.send(await serializeExperience(db, row));
    });
    app.patch("/orgs/:orgId/sites/:siteId/experiences/:experienceId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId, experienceId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const row = await loadExperience(db, site.id, experienceId);
        if (!row)
            return reply.code(404).send({ error: "experience_not_found" });
        const parsed = updateDraftSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, row.id)).orderBy(desc(experienceVersions.versionNumber));
        const draft = versions.find((version) => version.state === "draft");
        if (!draft)
            return reply.code(409).send({ error: "draft_not_found" });
        if (parsed.data.definition !== undefined) {
            const definition = definitionSchemaFor(row.kind).safeParse(parsed.data.definition);
            if (!definition.success)
                return reply.code(400).send({ error: "invalid_definition", details: definition.error.flatten() });
            const referenceError = await validateReferences(db, site.id, definition.data);
            if (referenceError)
                return reply.code(400).send({ error: referenceError });
            await db.update(experienceVersions).set({ definition: definition.data }).where(eq(experienceVersions.id, draft.id));
        }
        const [updated] = await db.update(experiences).set({ ...(parsed.data.name ? { name: parsed.data.name } : {}), updatedAt: new Date() }).where(eq(experiences.id, row.id)).returning();
        return reply.send(await serializeExperience(db, updated));
    });
    app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/publish", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId, experienceId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const row = await loadExperience(db, site.id, experienceId);
        if (!row)
            return reply.code(404).send({ error: "experience_not_found" });
        const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, row.id)).orderBy(desc(experienceVersions.versionNumber));
        const draft = versions.find((version) => version.state === "draft");
        if (!draft)
            return reply.code(409).send({ error: "draft_not_found" });
        const checked = definitionSchemaFor(row.kind).safeParse(draft.definition);
        if (!checked.success)
            return reply.code(400).send({ error: "invalid_definition", details: checked.error.flatten() });
        const requirementError = validatePublishRequirements(row.kind, row.widgetType, checked.data);
        if (requirementError)
            return reply.code(400).send({ error: requirementError });
        const referenceError = await validateReferences(db, site.id, checked.data);
        if (referenceError)
            return reply.code(400).send({ error: referenceError });
        const now = new Date();
        await db.update(experienceVersions).set({ state: "published", publishedAt: now }).where(eq(experienceVersions.id, draft.id));
        await db.insert(experienceVersions).values({ experienceId: row.id, versionNumber: draft.versionNumber + 1, state: "draft", definition: checked.data, createdBy: request.user.id });
        const [updated] = await db.update(experiences).set({ status: "published", publishedVersionId: draft.id, updatedAt: now }).where(eq(experiences.id, row.id)).returning();
        return reply.send(await serializeExperience(db, updated));
    });
    app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/pause", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId, experienceId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const row = await loadExperience(db, site.id, experienceId);
        if (!row)
            return reply.code(404).send({ error: "experience_not_found" });
        const [updated] = await db.update(experiences).set({ status: "paused", updatedAt: new Date() }).where(eq(experiences.id, row.id)).returning();
        return reply.send(await serializeExperience(db, updated));
    });
    app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/editor-sessions", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId, experienceId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const row = await loadExperience(db, site.id, experienceId);
        if (!row)
            return reply.code(404).send({ error: "experience_not_found" });
        if (!row.buildUrl || !urlBelongsToSite(row.buildUrl, site.domain))
            return reply.code(400).send({ error: "invalid_build_url" });
        const rawToken = crypto.randomBytes(32).toString("base64url");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        const [session] = await db.insert(experienceEditorSessions).values({ experienceId: row.id, siteId: site.id, dashboardUserId: request.user.id, tokenHash, allowedOrigin: new URL(row.buildUrl).origin, expiresAt }).returning();
        const launch = new URL(row.buildUrl);
        launch.searchParams.set("loopz_editor_token", rawToken);
        return reply.code(201).send({ sessionId: session.id, launchUrl: launch.toString(), expiresAt: expiresAt.toISOString() });
    });
    app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/editor-sessions/:sessionId/revoke", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId, experienceId, sessionId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const experience = await loadExperience(db, site.id, experienceId);
        if (!experience)
            return reply.code(404).send({ error: "experience_not_found" });
        const [session] = await db.select().from(experienceEditorSessions).where(eq(experienceEditorSessions.id, sessionId)).limit(1);
        if (!session || session.experienceId !== experience.id)
            return reply.code(404).send({ error: "editor_session_not_found" });
        await db.update(experienceEditorSessions).set({ revokedAt: new Date() }).where(eq(experienceEditorSessions.id, session.id));
        return reply.code(204).send();
    });
}
//# sourceMappingURL=experiences.js.map