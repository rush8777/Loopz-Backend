import { DraftWriteError, onsiteCompatible, saveExperienceDraft, validateReferences, assertNewDefinitionFeatures } from "../lib/experiences/draftWrites.js";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { experienceEditorSessions, experiences, experienceVersions, pageDefinitions, segments, sites, siteThemes } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { createExperienceSchema, definitionSchemaFor, guidePublishIssues, updateDraftSchema } from "../lib/experiences/validation.js";
import { guideStepRequiresTarget, type BuilderMode, type ChecklistExperienceDefinition, type ExperienceContent, type ExperienceDefinition, type ExperienceDesign, type ExperienceKind, type ExperienceTargeting, type GuideStep, type GuideStepPattern, type SurveyQuestion, type WidgetBuilderState, type WidgetType } from "../lib/experiences/types.js";
import { isChecklistDefinition } from "../lib/experiences/types.js";
import { initialChecklistDefinition, type ChecklistPreset } from "../lib/experiences/checklistPresets.js";
import { defaultWidgetSize, widgetSizeIsValid } from "../lib/experiences/widgetSizing.js";
import { getExperienceAnalytics, listExperienceAnalytics, listSurveyResponses } from "../lib/experiences/analytics.js";
import type { PageRule } from "../lib/pages/types.js";
import { runEntitlementTransaction } from "../db/transaction.js";
import { assertSubscriptionActive, createEntitlementService } from "../lib/entitlements/service.js";
import { sendEntitlementError } from "../lib/entitlements/http.js";
import { requiredExperienceFeatures } from "../lib/entitlements/experienceFeatures.js";
import type { SiteThemeTokens } from "../lib/themes/types.js";
import { siteThemeCss } from "../lib/themes/css.js";
import { applyOnsiteDocument, createOnsiteChecklistDocument, createOnsiteDocument, createOnsiteSurveyDocument, listBlocks } from "../lib/experiences/onsiteDocument.js";
import { onsiteId } from "../lib/experiences/onsiteDocument.js";
import { resolveTemplate, templatesFor, type VisualPresetId } from "../lib/experiences/templateRegistry.js";
import { presetTokens } from "../lib/themes/presets.js";
import type { VisualThemeState } from "../lib/themes/types.js";

const SUPPORTED_WIDGET_TYPES: WidgetType[] = ["anchored_card", "toast", "cursor_follow", "modal", "slideout", "hotspot", "banner", "survey"];


async function loadSiteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  return site?.orgId === orgId ? site : null;
}

async function loadExperience(db: Db, siteId: string, experienceId: string) {
  const [row] = await db.select().from(experiences).where(eq(experiences.id, experienceId)).limit(1);
  return row?.siteId === siteId ? row : null;
}

async function experienceNameExists(db: Db, siteId: string, name: string, excludeId?: string) {
  const rows = await db.select({ id: experiences.id, name: experiences.name }).from(experiences).where(eq(experiences.siteId, siteId));
  const normalizedName = name.toLowerCase();
  return rows.some((row) => row.id !== excludeId && row.name.toLowerCase() === normalizedName);
}

function siteOrigin(domain: string | null): string | null {
  if (!domain) return null;
  try {
    return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin;
  } catch {
    return null;
  }
}

function urlBelongsToSite(url: string, domain: string | null): boolean {
  const origin = siteOrigin(domain);
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function deriveBuildUrl(domain: string | null, rules: PageRule[]): string | null {
  const origin = siteOrigin(domain);
  if (!origin) return null;
  const rule = rules.find((item) => item.kind === "include");
  if (!rule) return origin;
  const path = rule.value.replace(/\*/g, "").trim();
  return new URL(path.startsWith("/") ? path : "/", origin).toString();
}

const DEFAULT_DESIGN = {
  width: "md" as const,
  theme: { background: "#ffffff", foreground: "#111827", primary: "#2563eb", borderRadius: "md" as const },
};

function targeting(pageRules: PageRule[]): ExperienceTargeting {
  return { pageRules, audience: { type: "all" }, trigger: { type: "page_load" }, frequency: { mode: "once" }, priority: 0 };
}



function escapeBuilderText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function onsiteBuilder(content: ExperienceContent, widgetType: string): WidgetBuilderState {
  const guide = content.primaryAction?.type === "next_step"; const document = createOnsiteDocument(guide); const blocks = listBlocks(document.root);
  const heading = blocks.find(block => block.type === "heading"); if (heading?.type === "heading") heading.html = escapeBuilderText(content.heading);
  const body = blocks.find(block => block.type === "text"); if (body?.type === "text") body.html = escapeBuilderText(content.body);
  const button = blocks.find(block => block.type === "button");
  if (button?.type === "button" && content.primaryAction) { const action = content.primaryAction; button.label = action.label; button.action = { id: button.action.id, ...(action.type === "open_url" && action.url ? { type: "open_url" as const, url: action.url } : action.type === "track_event" && action.eventName ? { type: "track_event" as const, eventName: action.eventName } : { type: action.type === "next_step" ? "next_step" as const : "dismiss" as const }) }; }
  const builder: WidgetBuilderState = { version: 1, projectData: {}, html: "", css: "" }; applyOnsiteDocument(builder, document, widgetType as WidgetType); return builder;
}

function initialDefinition(kind: ExperienceKind, widgetType: WidgetType | null, pageRules: PageRule[], siteTheme?: SiteThemeTokens, builderMode: BuilderMode = "grapesjs", guidePattern: GuideStepPattern = "anchored_card"): ExperienceDefinition {
  if (kind === "checklist") return initialChecklistDefinition("default", siteTheme);
  const content: ExperienceContent = {
    heading: kind === "guide" ? "Welcome" : "A helpful message",
    body: "Add a concise message for your visitors.",
    ...(builderMode === "onsite" ? { primaryAction: { label: kind === "guide" ? "Next" : "Got it", type: kind === "guide" ? "next_step" as const : "dismiss" as const } } : {}),
  };
  if (kind === "guide") {
    const behavior = guidePattern === "modal"
      ? { dismissible: true, layer: { mode: "always_on_top" as const } }
      : { placement: "auto" as const, alignment: "center" as const, offset: 8, pointer: { enabled: true, size: 10 }, dismissible: true, layer: { mode: "auto" as const } };
    return { steps: [{ id: onsiteId("step"), pattern: guidePattern, content, ...(builderMode === "onsite" ? { builder: onsiteBuilder(content, guidePattern) } : {}), behavior }], design: themedDesign(siteTheme), behavior: { layer: { mode: "auto" } }, targeting: targeting(pageRules) };
  }
  const definition: ExperienceDefinition = {
    content,
    design: { ...themedDesign(siteTheme), size: defaultWidgetSize(widgetType!) },
    behavior: {
      dismissible: true,
      layer: { mode: widgetType === "modal" ? "always_on_top" : "auto" },
      ...(widgetType === "toast" ? { toastPosition: "bottom-right" as const, autoDismissMs: null } : {}),
      ...(widgetType === "cursor_follow" ? { cursorOffset: { x: 16, y: 16 } } : {}),
      ...(widgetType === "anchored_card" || widgetType === "hotspot" ? { placement: "auto" as const, alignment: "center" as const, offset: 8 } : {}),
      ...(widgetType === "anchored_card" ? { pointer: { enabled: true, size: 10 } } : {}),
      ...(widgetType === "modal" || widgetType === "survey" ? { modalLayout: "center" as const, backdrop: true, backdropOpacity: 0.45, closeOnBackdrop: false } : {}),
      ...(widgetType === "slideout" ? { slideoutPosition: "bottom-right" as const, backdrop: false, backdropOpacity: 0.35, closeOnBackdrop: false } : {}),
      ...(widgetType === "banner" ? { bannerPosition: "top" as const, bannerDisplayMode: "inline" as const } : {}),
      ...(widgetType === "hotspot" ? { hotspotStyle: "pulse" as const, hotspotColor: siteTheme?.colors.primary ?? DEFAULT_DESIGN.theme.primary } : {}),
    },
    targeting: targeting(pageRules),
    ...(builderMode === "onsite" ? { builder: onsiteBuilder(content, widgetType!) } : {}),
  };
  if (widgetType === "survey" && "content" in definition) {
    const firstId = `survey_step_${crypto.randomBytes(6).toString("hex")}`;
    const secondId = `survey_step_${crypto.randomBytes(6).toString("hex")}`;
    const ratingId = `question_${crypto.randomBytes(6).toString("hex")}`;
    const detailId = `question_${crypto.randomBytes(6).toString("hex")}`;
    definition.content = { heading: "How easy was it to complete this task?", body: "Your feedback helps us improve the experience." };
    definition.survey = {
      showProgress: true, allowBack: true, submitLabel: "Submit feedback",
      steps: [
        {
          id: firstId,
          content: { heading: "How easy was it to complete this task?", body: "Your feedback helps us improve the experience." },
          questions: [
            { id: ratingId, type: "rating", label: "How easy was it to complete this task?", required: true, min: 1, max: 5 },
            { id: detailId, type: "long_text", label: "What was the most challenging part?", required: false, placeholder: "Tell us more (optional)", maxLength: 2000 },
          ],
          builder: surveyStarter(firstId, ratingId, detailId, false, siteTheme),
        },
        {
          id: secondId,
          content: { heading: "Anything else to share?", body: "Add more questions here, or use this as a simple follow-up slide." },
          questions: [],
          builder: surveyStarter(secondId, null, null, true, siteTheme),
        },
      ],
    };
    if (builderMode === "onsite") {
      delete definition.builder;
      for (const step of definition.survey.steps) {
        step.builder = { version: 1, projectData: {}, html: "", css: "" };
        step.content = applyOnsiteDocument(step.builder, createOnsiteSurveyDocument(step.questions, step.content), "survey", { questions: step.questions, submitLabel: definition.survey.submitLabel }).content;
      }
      definition.content = { ...definition.survey.steps[0].content };
    }
  }
  return definition;
}

function surveyStarter(stepId: string, ratingId: string | null, detailId: string | null, final: boolean, theme?: SiteThemeTokens) {
  const questions = ratingId && detailId ? `<div class="movcues-survey-question movcues-survey-question--rating" data-movcues-question-id="${ratingId}" data-movcues-question-type="rating"><p class="movcues-survey-question__label">How easy was it to complete this task? <span aria-hidden="true">*</span></p><div class="movcues-survey-options" role="group" aria-label="Rating">${[1,2,3,4,5].map(value => `<button type="button" class="movcues-survey-option" data-movcues-option-id="${value}" aria-pressed="false">${value}</button>`).join("")}</div></div><div class="movcues-survey-question movcues-survey-question--long_text" data-movcues-question-id="${detailId}" data-movcues-question-type="long_text"><label class="movcues-survey-question__label">What was the most challenging part?</label><textarea class="movcues-survey-input" data-movcues-question-input placeholder="Tell us more (optional)" maxlength="2000" aria-label="What was the most challenging part?"></textarea></div>` : `<p class="movcues-widget__body" data-movcues-content="body">Add more questions here, or use this as a simple follow-up slide.</p>`;
  const back = final ? `<button type="button" class="movcues-survey-button movcues-survey-button--back" data-movcues-survey-action="back">Back</button>` : "";
  const action = final ? "submit" : "next"; const label = final ? "Submit feedback" : "Next →";
  const html = `<section class="movcues-widget movcues-widget--survey" data-movcues-widget-type="survey" data-movcues-survey-step-id="${stepId}"><span class="movcues-widget__eyebrow">We'd love your feedback</span><h2 class="movcues-widget__heading" data-movcues-content="heading">${final ? "Anything else to share?" : "How easy was it to complete this task?"}</h2>${questions}<div class="movcues-survey-validation" role="status" aria-live="polite"></div><div class="movcues-survey-footer">${back}<div class="movcues-survey-progress" data-movcues-survey-progress><span>Step ${final ? 2 : 1} of 2</span><span class="movcues-survey-progress__track"><span data-movcues-survey-progress-bar></span></span></div><button type="button" class="movcues-survey-button" data-movcues-survey-action="${action}">${label}</button></div></section>`;
  const css = `.movcues-widget{box-sizing:border-box;width:100%;padding:36px;background:#fff;color:#111827;border:1px solid rgba(15,23,42,.1);border-radius:16px;font-family:ui-sans-serif,system-ui,sans-serif;box-shadow:0 24px 70px rgba(15,23,42,.22)}.movcues-widget .movcues-widget__eyebrow{display:block;margin-bottom:10px;color:#2563eb;font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}.movcues-widget .movcues-widget__heading{margin:0 0 26px;font-size:28px;line-height:1.2}.movcues-widget .movcues-widget__body{margin:0 0 28px;color:#64748b;line-height:1.6}.movcues-widget .movcues-survey-question{margin:0 0 24px}.movcues-widget .movcues-survey-question__label{display:block;margin:0 0 10px;font-size:14px;font-weight:650}.movcues-widget .movcues-survey-options{display:grid;grid-template-columns:repeat(5,minmax(44px,1fr));gap:9px}.movcues-widget .movcues-survey-option{min-height:46px;border:1px solid #dbe2ea;border-radius:10px;background:#fff;color:#334155;font:700 14px inherit;cursor:pointer}.movcues-widget .movcues-survey-option:hover,.movcues-widget .movcues-survey-option.is-selected{border-color:#2563eb;background:#eff6ff;color:#1d4ed8}.movcues-widget .movcues-survey-input{box-sizing:border-box;width:100%;min-height:110px;padding:12px 14px;resize:vertical;border:1px solid #dbe2ea;border-radius:10px;background:#fff;color:#111827;font:14px/1.5 inherit}.movcues-widget .movcues-survey-input:focus{outline:2px solid #bfdbfe;border-color:#2563eb}.movcues-widget .movcues-survey-validation{min-height:18px;color:#b91c1c;font-size:12px}.movcues-widget .movcues-survey-footer{display:flex;align-items:center;gap:12px;margin-top:10px}.movcues-widget .movcues-survey-progress{display:flex;flex:1;align-items:center;gap:12px;color:#64748b;font-size:12px}.movcues-widget .movcues-survey-progress__track{height:5px;flex:1;overflow:hidden;border-radius:99px;background:#e2e8f0}.movcues-widget [data-movcues-survey-progress-bar]{display:block;width:${final ? 100 : 50}%;height:100%;background:#2563eb}.movcues-widget .movcues-survey-button{border:0;border-radius:9px;padding:10px 16px;background:#2563eb;color:#fff;font:700 13px inherit;cursor:pointer}.movcues-widget .movcues-survey-button--back{background:#f1f5f9;color:#334155}@media(max-width:600px){.movcues-widget{padding:24px}.movcues-widget .movcues-widget__heading{font-size:23px}.movcues-widget .movcues-survey-footer{flex-wrap:wrap}.movcues-widget .movcues-survey-progress{order:-1;flex-basis:100%}}`;
  return { version: 1 as const, projectData: {}, html, css: theme ? `${css}${siteThemeCss(theme)}` : css };
}

function themedDesign(theme?: SiteThemeTokens) {
  if (!theme) return DEFAULT_DESIGN;
  return { width: "md" as const, theme: { background: theme.colors.background, foreground: theme.colors.text, primary: theme.colors.primary, borderRadius: (theme.radii.md <= 6 ? "sm" : theme.radii.md >= 18 ? "lg" : "md") as "sm" | "md" | "lg", siteTheme: theme } };
}

function templateTokens(template: ReturnType<typeof resolveTemplate>): SiteThemeTokens {
  const tokens = presetTokens(template?.preset ?? "modern");
  if (template) { tokens.colors.primary = template.accent; tokens.colors.surface = template.surface; }
  return tokens;
}

function visualTheme(template: ReturnType<typeof resolveTemplate>, requested: { source: "template" | "site" | "preset"; preset?: VisualPresetId } | undefined, captured?: SiteThemeTokens): { state: VisualThemeState; tokens: SiteThemeTokens } {
  const defaults = templateTokens(template);
  const source = requested?.source ?? (captured ? "site" : "template");
  const base = source === "site" && captured ? structuredClone(captured) : source === "preset" ? presetTokens(requested?.preset ?? "modern") : structuredClone(defaults);
  return { tokens: base, state: { source, ...(source === "preset" ? { preset: requested?.preset ?? "modern" } : {}), ...(template ? { templateId: template.id } : {}), templateTokens: defaults, baseTokens: structuredClone(base), overrides: {} } };
}

function applyDesign(definition: ExperienceDefinition, design: ExperienceDesign, state: VisualThemeState, templateId?: string): void {
  if ("items" in definition) definition.design = design; else definition.design = design;
  definition.visualTheme = state;
  if (templateId) definition.template = { id: templateId, version: 1 };
}

function widgetTemplateCopy(id: string): { heading: string; body: string; action: string } {
  const copy: Record<string, { heading: string; body: string; action: string }> = {
    "widget-welcome-modal": { heading: "Welcome — let's get you set up", body: "Discover the essentials and reach your first win in just a few minutes.", action: "Show me around" },
    "widget-feature-announcement": { heading: "A faster way to finish your work", body: "Meet the redesigned workflow that keeps your team focused and moving.", action: "Explore the update" },
    "widget-upgrade-slideout": { heading: "Unlock more for your team", body: "Upgrade to collaborate without limits and access advanced insights.", action: "View plans" },
    "widget-feature-tooltip": { heading: "New: saved views", body: "Save this filtered view and return to it whenever you need it.", action: "Got it" },
    "widget-notification-toast": { heading: "Changes saved", body: "Your latest updates are ready for the team.", action: "Dismiss" },
  };
  return copy[id] ?? { heading: "A helpful message", body: "Add a concise message for your visitors.", action: "Got it" };
}

function guideTemplateSteps(id: string): Array<{ pattern: GuideStepPattern; heading: string; body: string }> {
  if (id === "guide-feature-discovery") return [
    { pattern: "modal", heading: "Discover a smarter workflow", body: "We'll show you one useful feature and where it fits in your day." },
    { pattern: "anchored_card", heading: "Find it right here", body: "Use this control to open the feature whenever you need it." },
    { pattern: "modal", heading: "You're ready", body: "Try it now and make the workflow your own." },
  ];
  if (id === "guide-product-tour") return [
    { pattern: "modal", heading: "Your product tour", body: "Take a quick look at the areas that help teams move faster." },
    { pattern: "anchored_card", heading: "Keep work organized", body: "Use this area to find, filter, and manage active work." },
    { pattern: "anchored_card", heading: "See progress clearly", body: "Review progress and spot anything that needs attention." },
    { pattern: "modal", heading: "Tour complete", body: "You're ready to explore. You can reopen this tour whenever you need it." },
  ];
  return [
    { pattern: "modal", heading: "Welcome aboard", body: "Let's complete the essentials so you can get value right away." },
    { pattern: "modal", heading: "Make it yours", body: "Set your preferences and invite teammates when you're ready." },
    { pattern: "modal", heading: "Create your first win", body: "Start the core workflow now — we'll keep the next step clear." },
  ];
}

function question(type: SurveyQuestion["type"], label: string, required = false): SurveyQuestion {
  const id = onsiteId("question");
  if (type === "single_choice" || type === "multiple_choice") return { id, type, label, required, options: ["Very useful", "Somewhat useful", "Not useful yet"].map(labelValue => ({ id: onsiteId("option"), label: labelValue })) };
  if (type === "rating") return { id, type, label, required, min: 1, max: 5 };
  if (type === "nps") return { id, type, label, required };
  return { id, type, label, required, placeholder: "Share a little more…", maxLength: type === "short_text" ? 500 : 2000 };
}

function surveyQuestions(id: string): Array<{ heading: string; body: string; questions: SurveyQuestion[] }> {
  if (id === "survey-nps") return [
    { heading: "How likely are you to recommend us?", body: "Choose a score from 0 to 10.", questions: [question("nps", "How likely are you to recommend us to a friend or colleague?", true)] },
    { heading: "What shaped your score?", body: "Your feedback helps us focus on what matters.", questions: [question("long_text", "What is the main reason for your score?")] },
  ];
  if (id === "survey-feature-feedback") return [
    { heading: "How is this feature working for you?", body: "Tell us what helps and what could be better.", questions: [question("single_choice", "How useful is this feature?", true), question("long_text", "What would improve it most?")] },
  ];
  return [
    { heading: "How satisfied are you?", body: "A quick rating helps us improve your experience.", questions: [question("rating", "How satisfied are you with your experience?", true), question("long_text", "What could we do better?")] },
  ];
}

function checklistCopy(id: string): Pick<ChecklistExperienceDefinition, "title" | "description" | "items" | "completionMessage"> {
  const rows = id === "checklist-account-setup" ? [
    ["Complete your profile", "Add the details teammates use to recognize you."], ["Secure your account", "Review sign-in and recovery settings."], ["Invite a teammate", "Bring one collaborator into the workspace."],
  ] : id === "checklist-product-activation" ? [
    ["Connect your data", "Bring in the source that powers your workflow."], ["Create your first project", "Set up a real workspace for your team."], ["Complete the core action", "Finish one workflow from start to result."],
  ] : [
    ["Personalize your workspace", "Choose the settings that fit how you work."], ["Create your first item", "Turn an idea into a real piece of work."], ["Share it with your team", "Invite someone to review or collaborate."],
  ];
  return { title: id === "checklist-account-setup" ? "Set up your account" : id === "checklist-product-activation" ? "Activate your workspace" : "Getting started", description: "Complete these quick steps to get the most from your workspace.", items: rows.map(([title, description]) => ({ id: onsiteId("item"), title, description, action: { type: "none" as const }, completion: { type: "item_clicked" as const } })), completionMessage: { title: "You're all set", description: "Everything is ready for your next step.", acknowledgeLabel: "Continue" } };
}

function instantiateTemplate(definition: ExperienceDefinition, kind: ExperienceKind, widgetType: WidgetType | null, templateId: string): ExperienceDefinition {
  if (templateId === "blank") return definition;
  if (kind === "checklist" && "items" in definition) {
    const copy = checklistCopy(templateId); Object.assign(definition, copy);
    applyOnsiteDocument(definition.builder, createOnsiteChecklistDocument(definition), "checklist", undefined, definition);
    return definition;
  }
  if (kind === "guide" && "steps" in definition) {
    definition.steps = guideTemplateSteps(templateId).map((spec, index, all): GuideStep => {
      const content: ExperienceContent = { heading: spec.heading, body: spec.body, primaryAction: { label: index === all.length - 1 ? "Finish" : "Next", type: index === all.length - 1 ? "dismiss" : "next_step" } };
      return { id: onsiteId("step"), label: spec.heading, pattern: spec.pattern, content, builder: onsiteBuilder(content, spec.pattern), advance: { type: "button" }, behavior: spec.pattern === "modal" ? { dismissible: true } : { placement: "auto", alignment: "center", offset: 8, pointer: { enabled: true, size: 10 }, dismissible: true } };
    });
    return definition;
  }
  if (kind === "widget" && widgetType === "survey" && "content" in definition) {
    const steps = surveyQuestions(templateId); const submitLabel = "Submit feedback";
    definition.survey = { showProgress: steps.length > 1, allowBack: true, submitLabel, steps: steps.map(spec => {
      const builder: WidgetBuilderState = { version: 1, projectData: {}, html: "", css: "" };
      const content = applyOnsiteDocument(builder, createOnsiteSurveyDocument(spec.questions, { heading: spec.heading, body: spec.body }), "survey", { questions: spec.questions, submitLabel }).content;
      return { id: onsiteId("step"), content, questions: spec.questions, builder };
    }) };
    definition.content = { ...definition.survey.steps[0].content };
    return definition;
  }
  if (kind === "widget" && "content" in definition) {
    const copy = widgetTemplateCopy(templateId);
    definition.content = { heading: copy.heading, body: copy.body, primaryAction: { label: copy.action, type: templateId === "widget-upgrade-slideout" ? "open_url" : "dismiss", ...(templateId === "widget-upgrade-slideout" ? { url: "https://example.com/plans" } : {}) } };
    definition.builder = onsiteBuilder(definition.content, widgetType ?? "modal");
  }
  return definition;
}

async function serializeExperience(db: Db, row: typeof experiences.$inferSelect) {
  const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, row.id)).orderBy(desc(experienceVersions.versionNumber));
  const draft = versions.find((version) => version.state === "draft") ?? null;
  const published = versions.find((version) => version.id === row.publishedVersionId) ?? null;
  return {
    ...row,
    launchSetupCompletedAt: row.launchSetupCompletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    draftVersion: draft ? { ...draft, definition: draft.definition as ExperienceDefinition, createdAt: draft.createdAt.toISOString(), publishedAt: null } : null,
    publishedVersion: published ? { ...published, definition: published.definition as ExperienceDefinition, createdAt: published.createdAt.toISOString(), publishedAt: published.publishedAt?.toISOString() ?? null } : null,
  };
}

function validatePublishRequirements(kind: ExperienceKind, widgetType: WidgetType | null, definition: ExperienceDefinition): string | null {
  if (kind === "guide") {
    if (!("steps" in definition) || definition.steps.some((step) => guideStepRequiresTarget(step) && !step.target)) return "target_required";
  } else if ((widgetType === "anchored_card" || widgetType === "hotspot") && (!("content" in definition) || !definition.target)) {
    return "target_required";
  }
  return null;
}

export function registerExperienceRoutes(app: FastifyInstance, db: Db) {
  const analyticsRangeSchema = z.object({ since: z.coerce.date().optional(), until: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
  const responseQuerySchema = analyticsRangeSchema.extend({
    status: z.enum(["submitted", "abandoned", "started"]).optional(),
    identityType: z.enum(["identified", "anonymous"]).optional(),
    versionId: z.string().min(1).max(100).optional(), questionId: z.string().min(1).max(200).optional(), answer: z.string().max(2000).optional(),
    ratingMin: z.coerce.number().optional(), ratingMax: z.coerce.number().optional(), npsCategory: z.enum(["promoter", "passive", "detractor"]).optional(),
  });
  const range = (value: { since?: Date; until?: Date }) => { const until = value.until ?? new Date(); return { since: value.since ?? new Date(until.getTime() - 30 * 86_400_000), until }; };

  app.get("/orgs/:orgId/sites/:siteId/experience-analytics", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string }; const site = await loadSiteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const parsed = analyticsRangeSchema.safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    return listExperienceAnalytics(db, site.id, range(parsed.data));
  });

  app.get("/orgs/:orgId/sites/:siteId/experiences/:experienceId/analytics", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string }; const site = await loadSiteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const parsed = analyticsRangeSchema.safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    const result = await getExperienceAnalytics(db, site.id, experienceId, range(parsed.data)); return result ? reply.send(result) : reply.code(404).send({ error: "experience_not_found" });
  });

  app.get("/orgs/:orgId/sites/:siteId/experiences/:experienceId/responses", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string }; const site = await loadSiteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const parsed = responseQuerySchema.safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    const result = await listSurveyResponses(db, site.id, experienceId, range(parsed.data), parsed.data.limit, parsed.data.offset, parsed.data);
    return result ? reply.send(result) : reply.code(404).send({ error: "survey_not_found" });
  });
  app.get("/orgs/:orgId/sites/:siteId/experiences", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const { kind, widgetType } = request.query as { kind?: string; widgetType?: string };
    if (kind && kind !== "guide" && kind !== "widget" && kind !== "checklist") return reply.code(400).send({ error: "invalid_kind" });
    if (widgetType && !SUPPORTED_WIDGET_TYPES.includes(widgetType as WidgetType)) return reply.code(400).send({ error: "invalid_widget_type" });
    if (widgetType && kind !== "widget") return reply.code(400).send({ error: "widget_type_requires_widget_kind" });
    const rows = await db.select().from(experiences).where(eq(experiences.siteId, site.id)).orderBy(desc(experiences.updatedAt));
    const filtered = rows.filter((row) => (!kind || row.kind === kind) && (!widgetType || row.widgetType === widgetType));
    return reply.send({ experiences: await Promise.all(filtered.map((row) => serializeExperience(db, row))) });
  });

  app.get("/orgs/:orgId/sites/:siteId/experience-templates", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const query = z.object({ kind: z.enum(["guide", "widget", "checklist"]), widgetType: z.enum(SUPPORTED_WIDGET_TYPES as [WidgetType, ...WidgetType[]]).nullable().optional() }).safeParse(request.query);
    if (!query.success || (query.data.kind === "widget") !== Boolean(query.data.widgetType)) return reply.code(400).send({ error: "invalid_query" });
    const [theme] = await db.select({ activeTokens: siteThemes.activeTokens }).from(siteThemes).where(eq(siteThemes.siteId, site.id)).limit(1);
    return reply.send({ templates: templatesFor(query.data.kind, query.data.widgetType), presets: ["minimal", "modern", "soft", "dark"], hasSiteTheme: Boolean(theme?.activeTokens) });
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const parsed = createExperienceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    if (await experienceNameExists(db, site.id, parsed.data.name)) return reply.code(409).send({ error: "experience_name_exists", message: "An experience with this name already exists." });

    let page: typeof pageDefinitions.$inferSelect | null = null;
    if (parsed.data.buildPageId) {
      [page] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, parsed.data.buildPageId)).limit(1);
      if (!page || page.siteId !== site.id) return reply.code(400).send({ error: "invalid_build_page" });
    }
    const buildUrl = parsed.data.kind === "checklist" && parsed.data.builderMode !== "onsite" ? null : parsed.data.buildUrl ?? (page ? deriveBuildUrl(site.domain, page.rules as PageRule[]) : null);
    if ((parsed.data.kind !== "checklist" || parsed.data.builderMode === "onsite") && (!buildUrl || !urlBelongsToSite(buildUrl, site.domain))) return reply.code(400).send({ error: "build_url_outside_site_domain" });
    const initialPageRules = parsed.data.useBuildPageAsTarget
      ? page
        ? (page.rules as PageRule[])
        : [{ id: "build_page", kind: "include" as const, operator: "equals" as const, value: new URL(buildUrl!).pathname }]
      : [];
    const [storedTheme] = await db.select({ activeTokens: siteThemes.activeTokens }).from(siteThemes).where(eq(siteThemes.siteId, site.id)).limit(1);
    const activeTheme = (storedTheme?.activeTokens ?? undefined) as SiteThemeTokens | undefined;
    if (parsed.data.builderMode === "onsite" && !onsiteCompatible(parsed.data.kind, parsed.data.widgetType ?? null)) return reply.code(400).send({ error: "onsite_builder_unsupported" });
    const isLegacyChecklistPreset = parsed.data.kind === "checklist" && ["default","minimal","soft","compact"].includes(parsed.data.template);
    const legacyPreset = isLegacyChecklistPreset ? parsed.data.template as ChecklistPreset : "default";
    let definition = parsed.data.kind === "checklist" ? initialChecklistDefinition(legacyPreset, activeTheme) : initialDefinition(parsed.data.kind, parsed.data.widgetType ?? null, initialPageRules, activeTheme, parsed.data.builderMode, parsed.data.guidePattern);
    const selectedTemplate = resolveTemplate(parsed.data.template, parsed.data.kind, parsed.data.widgetType ?? null);
    const selectedTheme = visualTheme(selectedTemplate, parsed.data.theme, activeTheme);
    if (parsed.data.builderMode === "onsite") {
      definition = instantiateTemplate(definition, parsed.data.kind, parsed.data.widgetType ?? null, isLegacyChecklistPreset ? "blank" : parsed.data.template);
      const design = { ...themedDesign(selectedTheme.tokens), ...(parsed.data.kind === "widget" ? { size: defaultWidgetSize(parsed.data.widgetType!) } : {}) };
      applyDesign(definition, design, selectedTheme.state, selectedTemplate?.id);
      if (parsed.data.kind === "checklist" && isChecklistDefinition(definition) && (parsed.data.template === "blank" || isLegacyChecklistPreset)) applyOnsiteDocument(definition.builder,createOnsiteChecklistDocument(definition),"checklist",undefined,definition);
    }

    let experience: typeof experiences.$inferSelect;
    try {
      experience = await runEntitlementTransaction(db, async tx => {
        await assertSubscriptionActive(tx, site.orgId);
        const [created] = await tx.insert(experiences).values({ siteId: site.id, kind: parsed.data.kind, widgetType: parsed.data.kind === "widget" ? parsed.data.widgetType! : null, builderMode: parsed.data.builderMode, name: parsed.data.name, buildPageId: page?.id ?? null, buildUrl: buildUrl ?? null, createdBy: request.user!.id }).returning();
        await tx.insert(experienceVersions).values({ experienceId: created.id, versionNumber: 1, state: "draft", definition, createdBy: request.user!.id });
        return created;
      });
    } catch (error) { return sendEntitlementError(reply, error); }
    return reply.code(201).send(await serializeExperience(db, experience));
  });

  app.get("/orgs/:orgId/sites/:siteId/experiences/:experienceId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    return reply.send(await serializeExperience(db, row));
  });

  app.patch("/orgs/:orgId/sites/:siteId/experiences/:experienceId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    if (request.body && typeof request.body === "object" && "builderMode" in request.body) return reply.code(409).send({ error: "builder_mode_locked" });
    const parsed = updateDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    if (parsed.data.name && await experienceNameExists(db, site.id, parsed.data.name, row.id)) return reply.code(409).send({ error: "experience_name_exists", message: "An experience with this name already exists." });
    const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, row.id)).orderBy(desc(experienceVersions.versionNumber));
    const draft = versions.find((version) => version.state === "draft");
    if (!draft) return reply.code(409).send({ error: "draft_not_found" });
    if (parsed.data.definition !== undefined || parsed.data.settings !== undefined) {
      if (parsed.data.definition !== undefined && row.builderMode !== "grapesjs") return reply.code(409).send({ error: "builder_mode_mismatch" });
      if (draft.revision !== parsed.data.revision) return reply.code(409).send({ error: "draft_conflict", currentRevision: draft.revision });
      const candidate = parsed.data.settings
        ? { ...(draft.definition as ExperienceDefinition), targeting: parsed.data.settings.targeting }
        : parsed.data.definition;
      const definition = definitionSchemaFor(row.kind as ExperienceKind, row.widgetType).safeParse(candidate);
      if (!definition.success) return reply.code(400).send({ error: "invalid_definition", details: { ...definition.error.flatten(), issues: definition.error.issues } });
      if (row.kind === "widget" && row.widgetType && !widgetSizeIsValid(row.widgetType as WidgetType, definition.data)) return reply.code(400).send({ error: "invalid_widget_size" });
      try {
        await saveExperienceDraft(db, site, row, draft, definition.data, parsed.data.revision);
      } catch (error) { if (error instanceof DraftWriteError) return reply.code(error.status).send({ error: error.message }); return sendEntitlementError(reply, error); }
    }
    const [updated] = await db.update(experiences).set({ ...(parsed.data.name ? { name: parsed.data.name } : {}), updatedAt: new Date() }).where(eq(experiences.id, row.id)).returning();
    return reply.send(await serializeExperience(db, updated));
  });

  app.delete("/orgs/:orgId/sites/:siteId/experiences/:experienceId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    await db.delete(experiences).where(eq(experiences.id, row.id));
    return reply.code(204).send();
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/launch-setup/complete", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    if (row.launchSetupCompletedAt) return reply.send(await serializeExperience(db, row));
    const [updated] = await db.update(experiences).set({ launchSetupCompletedAt: new Date(), updatedAt: new Date() }).where(eq(experiences.id, row.id)).returning();
    return reply.send(await serializeExperience(db, updated));
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/publish", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, row.id)).orderBy(desc(experienceVersions.versionNumber));
    const draft = versions.find((version) => version.state === "draft");
    if (!draft) return reply.code(409).send({ error: "draft_not_found" });
    const review = z.object({ draftVersionId: z.string().min(1), revision: z.number().int().positive() }).strict().safeParse(request.body);
    if (!review.success) return reply.code(400).send({ error: "reviewed_revision_required" });
    if (review.data.draftVersionId !== draft.id || review.data.revision !== draft.revision) return reply.code(409).send({ error: "reviewed_draft_changed" });
    const checked = definitionSchemaFor(row.kind as ExperienceKind, row.widgetType).safeParse(draft.definition);
    if (!checked.success) return reply.code(400).send({ error: "invalid_definition", details: { ...checked.error.flatten(), issues: checked.error.issues } });
    if (row.kind === "widget" && row.widgetType && !widgetSizeIsValid(row.widgetType as WidgetType, checked.data)) return reply.code(400).send({ error: "invalid_widget_size" });
    if ("steps" in checked.data) {
      const issues = guidePublishIssues(checked.data);
      if (issues.length) return reply.code(400).send({ error: issues.some(issue => issue.path.at(-1) === "target") ? "target_required" : "invalid_guide_step_configuration", message: issues.map(issue => issue.message).join(" "), details: { issues } });
    }
    const requirementError = validatePublishRequirements(row.kind as ExperienceKind, row.widgetType as WidgetType | null, checked.data);
    if (requirementError) return reply.code(400).send({ error: requirementError });
    const referenceError = await validateReferences(db, site.id, checked.data, true);
    if (referenceError) return reply.code(400).send({ error: referenceError });
    const now = new Date();
    let updated: typeof experiences.$inferSelect;
    try {
      updated = await runEntitlementTransaction(db, async tx => {
        await assertSubscriptionActive(tx, site.orgId, now);
        const previousVersion = row.publishedVersionId ? versions.find(version => version.id === row.publishedVersionId) : null;
        await assertNewDefinitionFeatures(tx, site.orgId, previousVersion?.definition as ExperienceDefinition | null, checked.data);
        const previousDefinition = previousVersion ? definitionSchemaFor(row.kind as ExperienceKind, row.widgetType).safeParse(previousVersion.definition) : null;
        const previousEndsAt = previousDefinition?.success ? previousDefinition.data.targeting.schedule?.endsAt : undefined;
        const alreadyReservesCapacity = row.status === "published" && Boolean(previousVersion && previousVersion.state === "published" && (!previousEndsAt || new Date(previousEndsAt) > now));
        if (!alreadyReservesCapacity) await createEntitlementService(tx).assertCanPublishExperience({ orgId: site.orgId, siteId: site.id, resourceId: row.id });
        const [acknowledged] = await tx.update(experienceVersions).set({ state: "published", publishedAt: now }).where(and(eq(experienceVersions.id, review.data.draftVersionId), eq(experienceVersions.revision, review.data.revision), eq(experienceVersions.state, "draft"))).returning();
        if (!acknowledged) throw new DraftWriteError(409, "reviewed_draft_changed");
        await tx.insert(experienceVersions).values({ experienceId: row.id, versionNumber: draft.versionNumber + 1, state: "draft", definition: checked.data, createdBy: request.user!.id });
        const [published] = await tx.update(experiences).set({ status: "published", publishedVersionId: draft.id, updatedAt: now }).where(eq(experiences.id, row.id)).returning();
        return published;
      });
    } catch (error) { if (error instanceof DraftWriteError) return reply.code(error.status).send({ error: error.message }); return sendEntitlementError(reply, error); }
    return reply.send(await serializeExperience(db, updated));
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/pause", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    const [updated] = await db.update(experiences).set({ status: "paused", updatedAt: new Date() }).where(eq(experiences.id, row.id)).returning();
    return reply.send(await serializeExperience(db, updated));
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/editor-sessions", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    if (row.kind === "checklist" && row.builderMode !== "onsite") return reply.code(400).send({ error: "checklist_live_editor_unsupported" });
    if (!row.buildUrl || !urlBelongsToSite(row.buildUrl, site.domain)) return reply.code(400).send({ error: "invalid_build_url" });
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const [session] = await db.insert(experienceEditorSessions).values({ experienceId: row.id, siteId: site.id, dashboardUserId: request.user!.id, tokenHash, allowedOrigin: new URL(row.buildUrl).origin, expiresAt }).returning();
    const launch = new URL(row.buildUrl);
    launch.searchParams.set("movcues_editor_token", rawToken);
    return reply.code(201).send({ sessionId: session.id, launchUrl: launch.toString(), expiresAt: expiresAt.toISOString() });
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/editor-sessions/:sessionId/revoke", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId, sessionId } = request.params as { siteId: string; experienceId: string; sessionId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const experience = await loadExperience(db, site.id, experienceId);
    if (!experience) return reply.code(404).send({ error: "experience_not_found" });
    const [session] = await db.select().from(experienceEditorSessions).where(eq(experienceEditorSessions.id, sessionId)).limit(1);
    if (!session || session.experienceId !== experience.id) return reply.code(404).send({ error: "editor_session_not_found" });
    await db.update(experienceEditorSessions).set({ revokedAt: new Date() }).where(eq(experienceEditorSessions.id, session.id));
    return reply.code(204).send();
  });
}
