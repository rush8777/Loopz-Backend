import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "../../db/client.js";
import { experiences, experienceVersions, segments, sites } from "../../db/schema.js";
import type { ExperienceDefinition, ExperienceKind, WidgetType } from "./types.js";
import { isChecklistDefinition } from "./types.js";
import { onsiteProjectionIsConsistent } from "./builderContentContract.js";
import { rawOnsiteDocument, validateCompiledOnsiteBuilder } from "./onsiteDocument.js";
import { definitionSchemaFor } from "./validation.js";
import { widgetSizeIsValid } from "./widgetSizing.js";
import { assertSubscriptionActive, createEntitlementService } from "../entitlements/service.js";
import { requiredExperienceFeatures } from "../entitlements/experienceFeatures.js";
import { runEntitlementTransaction } from "../../db/transaction.js";

function siteOrigin(domain: string | null): string | null { try { return domain ? new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin : null; } catch { return null; } }
export const ONSITE_WIDGET_TYPES = new Set<WidgetType>(["anchored_card", "toast", "cursor_follow", "modal", "slideout", "banner", "survey"]);
export function onsiteCompatible(kind: ExperienceKind, widgetType: WidgetType | null): boolean { return kind === "guide" || (kind === "widget" && !!widgetType && ONSITE_WIDGET_TYPES.has(widgetType)); }
export class DraftWriteError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export async function validateReferences(db: Db, siteId: string, definition: ExperienceDefinition, publishing = false): Promise<string | null> {
  for (const rule of definition.targeting.pageRules) {
    if (!rule.value.trim()) return "invalid_page_targeting";
  }
  if (definition.targeting.pageRules.length > 0 && !definition.targeting.pageRules.some((rule) => rule.kind === "include")) return "invalid_page_targeting";
  const audience = definition.targeting.audience;
  const segmentIds = audience.type === "segment" ? [audience.segmentId] : audience.type === "segment_rules" ? audience.conditions.map(condition => condition.segmentId) : [];
  if (isChecklistDefinition(definition)) for (const item of definition.items) if (item.completion.type === "segment") segmentIds.push(item.completion.segmentId);
  for (const segmentId of new Set(segmentIds)) { const [segment] = await db.select().from(segments).where(eq(segments.id, segmentId)).limit(1); if (!segment || (segment && segment.siteId !== siteId)) return "invalid_segment"; }
  if (isChecklistDefinition(definition)) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1); const origin = siteOrigin(site?.domain ?? null);
    for (const item of definition.items) if (item.action.type === "navigate" && /^https?:\/\//i.test(item.action.url) && (!origin || new URL(item.action.url).origin !== origin)) return "navigate_url_outside_site_domain";
    const completionGuideIds = new Set(definition.items.filter(item => item.completion.type === "guide_completed").map(item => (item.completion as { type: "guide_completed"; experienceId: string }).experienceId));
    const launchGuideIds = new Set(definition.items.filter(item => item.action.type === "launch_guide").map(item => (item.action as { type: "launch_guide"; experienceId: string }).experienceId));
    for (const guideId of new Set([...completionGuideIds, ...launchGuideIds])) {
      const [guide] = await db.select().from(experiences).where(eq(experiences.id, guideId)).limit(1);
      if (!guide || (guide && (guide.siteId !== siteId || guide.kind !== "guide"))) return "invalid_guide";
      if (publishing && guide && launchGuideIds.has(guideId) && (guide.status !== "published" || !guide.publishedVersionId)) return "guide_unavailable";
    }
  }
  return null;
}

export async function assertNewDefinitionFeatures(db: Parameters<typeof createEntitlementService>[0], orgId: string, previous: ExperienceDefinition | null, next: ExperienceDefinition) {
  const previousFeatures = previous ? requiredExperienceFeatures(previous) : new Set();
  const service = createEntitlementService(db);
  for (const feature of requiredExperienceFeatures(next)) if (!previousFeatures.has(feature)) await service.assertFeature({ orgId }, feature);
}


/** One write policy for dashboard and authenticated SDK sessions. */
export async function saveExperienceDraft(db: Db, site: typeof sites.$inferSelect, experience: typeof experiences.$inferSelect, draft: typeof experienceVersions.$inferSelect, candidate: unknown, revision: number | undefined) {
  if (experience.siteId !== site.id) throw new DraftWriteError(403, "site_mismatch");
  if (draft.revision !== revision) throw new DraftWriteError(409, "draft_conflict");
  if (experience.builderMode === "onsite" && !onsiteCompatible(experience.kind as ExperienceKind, experience.widgetType as WidgetType | null)) throw new DraftWriteError(400, "onsite_builder_unsupported");
  const result = definitionSchemaFor(experience.kind as ExperienceKind, experience.widgetType).safeParse(candidate);
  if (!result.success) throw new DraftWriteError(400, "invalid_definition");
  const definition = result.data;
  if (experience.builderMode === "onsite" && !isChecklistDefinition(definition)) {
    const survey = "survey" in definition ? definition.survey : undefined;
    const parts = "steps" in definition ? definition.steps : survey?.steps ?? [definition];
    if (parts.some(part => !part.builder || (rawOnsiteDocument(part.builder) !== undefined
      ? validateCompiledOnsiteBuilder(part.builder, part.content, "pattern" in part ? part.pattern ?? "anchored_card" : experience.widgetType as WidgetType, "pattern" in part, survey && "questions" in part ? { questions: part.questions, submitLabel: survey.submitLabel } : undefined).length > 0
      : !onsiteProjectionIsConsistent(part.builder.html, part.content)))) throw new DraftWriteError(400, "inconsistent_onsite_content");
  }
  if (experience.kind === "widget" && experience.widgetType && !widgetSizeIsValid(experience.widgetType as WidgetType, definition)) throw new DraftWriteError(400, "invalid_widget_size");
  return runEntitlementTransaction(db, async tx => {
    await assertSubscriptionActive(tx, site.orgId);
    const referenceError = await validateReferences(tx as unknown as Db, site.id, definition);
    if (referenceError) throw new DraftWriteError(400, referenceError);
    await assertNewDefinitionFeatures(tx, site.orgId, draft.definition as ExperienceDefinition, definition);
    if (isDeepStrictEqual(draft.definition, definition)) return draft;
    const [saved] = await tx.update(experienceVersions).set({ definition, revision: draft.revision + 1 })
      .where(and(eq(experienceVersions.id, draft.id), eq(experienceVersions.state, "draft"), eq(experienceVersions.revision, draft.revision))).returning();
    if (!saved) throw new DraftWriteError(409, "draft_conflict");
    await tx.update(experiences).set({ updatedAt: new Date() }).where(eq(experiences.id, experience.id));
    return saved;
  });
}
