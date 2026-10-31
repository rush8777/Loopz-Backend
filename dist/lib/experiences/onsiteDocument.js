import { checklistCopy, escapeChecklist, CHECKLIST_CELL_CSS } from "./checklistMarkup.js";
import { surveyQuestionMarkup, surveyControlsMarkup, surveyQuestionErrors, SURVEY_CELL_CSS } from "./surveyMarkup.js";
import { parseFragment } from "parse5";
import { builderImageUrlIsSafe, builderLinkUrlIsSafe } from "./builderContentContract.js";
import { isSourceAuthored, sourceContentProjection, validateSourceMarkup } from "./sourceMarkup.js";
export const ONSITE_SCHEMA_VERSION = 2;
export const ONSITE_SURVEY_SCHEMA_VERSION = 3;
export const ONSITE_CHECKLIST_SCHEMA_VERSION = 4;
export const ONSITE_LIMITS = {
    maxDepth: 8,
    maxNodes: 120,
    maxRichText: 10_000,
    maxImageUrl: 2_000,
    maxInlineImage: 65_536,
    maxSerializedBytes: 250_000,
    minFixedSize: 24,
    maxFixedSize: 1_200,
};
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s-]+\)|[a-z]{1,20})$/i;
const SAFE_INLINE_TAGS = new Set(["BR", "STRONG", "EM", "U", "A", "UL", "OL", "LI"]);
const ICONS = { check: "✓", star: "★", info: "ℹ", warning: "⚠", sparkles: "✦", arrow: "→", heart: "♥", rocket: "🚀" };
let idSequence = 0;
export function onsiteId(prefix = "cell") {
    idSequence = (idSequence + 1) % 0xffff;
    const random = typeof crypto !== "undefined" && "getRandomValues" in crypto
        ? Array.from(crypto.getRandomValues(new Uint32Array(2))).map(value => value.toString(36)).join("")
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}${idSequence.toString(36)}`.slice(0, 64);
}
export function emptyCell(block) {
    return { type: "cell", id: onsiteId("cell"), direction: "column", sizing: { mode: "flexible", weight: 1 }, align: "stretch", justify: "start", gap: 12, padding: { top: 0, right: 0, bottom: 0, left: 0 }, ...(block ? { block } : {}) };
}
export function createBlock(type, guide = false) {
    const id = onsiteId("block");
    if (type.startsWith("checklist_"))
        throw new Error("Insert a structured Checklist component.");
    if (type === "question")
        throw new Error("Insert a canonical Survey question first.");
    if (type === "survey_controls")
        return { id, type };
    if (type === "heading")
        return { id, type, html: "A clear heading", level: 2, fontSize: 24, weight: 600, lineHeight: 1.25 };
    if (type === "text")
        return { id, type, html: "Add supporting text for your visitors.", fontSize: 15, weight: 400, lineHeight: 1.5 };
    if (type === "button")
        return { id, type, label: guide ? "Next" : "Got it", action: { id: onsiteId("action"), type: guide ? "next_step" : "dismiss" }, variant: "primary", radius: 8, paddingX: 16, paddingY: 9, width: "hug", align: "right" };
    if (type === "image")
        return { id, type, src: "", alt: "", fit: "cover", width: 100, radius: 8, align: "center" };
    if (type === "divider")
        return { id, type, orientation: "horizontal", thickness: 1, color: "#dbe2ea" };
    if (type === "spacer")
        return { id, type, size: 24 };
    return { id, type: "icon", icon: "sparkles", size: 28, color: "#2563eb", align: "center" };
}
export function createOnsiteDocument(guide = false) {
    const heading = emptyCell(createBlock("heading", guide));
    const text = emptyCell(createBlock("text", guide));
    const button = emptyCell(createBlock("button", guide));
    return { schemaVersion: 2, id: onsiteId("document"), root: { ...emptyCell(), direction: "column", gap: 12, padding: { top: 20, right: 20, bottom: 20, left: 20 }, children: [heading, text, button] } };
}
export function createOnsiteSurveyDocument(questions, content) {
    const document = createOnsiteDocument();
    document.schemaVersion = 3;
    const heading = document.root.children[0].block;
    if (heading.type === "heading" && content)
        heading.html = escapeText(content.heading);
    const body = document.root.children[1].block;
    if (body.type === "text" && content)
        body.html = escapeText(content.body);
    document.root.children = [...document.root.children.slice(0, 2), ...questions.map(question => emptyCell({ id: onsiteId("block"), type: "question", questionId: question.id, fontSize: 14 })), emptyCell(createBlock("survey_controls"))];
    document.root.children.forEach(cell => { cell.sizing = { mode: "hug" }; });
    return document;
}
export function validateOnsiteSurveyDocument(document, context) {
    const errors = surveyQuestionErrors(context.questions), counts = new Map();
    const known = new Set(context.questions.map(question => question.id));
    const blocks = listBlocks(document.root);
    for (const block of blocks)
        if (block.type === "question") {
            counts.set(block.questionId, (counts.get(block.questionId) ?? 0) + 1);
            if (!known.has(block.questionId))
                errors.push(`Orphaned question reference: ${block.questionId}.`);
        }
    for (const question of context.questions)
        if (counts.get(question.id) !== 1)
            errors.push(`Question ${question.id} must be referenced exactly once.`);
    if (blocks.filter(block => block.type === "survey_controls").length !== 1)
        errors.push("Survey cells need exactly one navigation/progress block.");
    return errors;
}
export function duplicateSurveyCell(document, questions, id) {
    const candidate = cloneOnsite(document), nextQuestions = cloneOnsite(questions);
    const cellId = duplicateCell(candidate, id);
    if (!cellId)
        return null;
    for (const block of listBlocks(findCell(candidate, cellId)))
        if (block.type === "question") {
            const source = questions.find(question => question.id === block.questionId);
            if (!source)
                return null;
            const copy = cloneOnsite(source);
            copy.id = onsiteId("question");
            if (copy.type === "single_choice" || copy.type === "multiple_choice")
                copy.options.forEach(option => { option.id = onsiteId("option"); });
            block.questionId = copy.id;
            nextQuestions.push(copy);
        }
    if (!validateOnsiteDocument(candidate).valid || validateOnsiteSurveyDocument(candidate, { questions: nextQuestions }).length)
        return null;
    return { document: candidate, questions: nextQuestions, cellId };
}
export function createOnsiteChecklistDocument(context) {
    const text = (role, size = 14) => emptyCell({ id: onsiteId('block'), type: 'checklist_text', role, fontSize: size });
    const control = (role) => emptyCell({ id: onsiteId('block'), type: 'checklist_control', role, fontSize: 14 });
    const group = (role, children) => ({ ...emptyCell(), checklistRole: role, sizing: { mode: 'hug' }, padding: role === 'items' ? { top: 0, right: 0, bottom: 0, left: 0 } : { top: 16, right: 16, bottom: 16, left: 16 }, children });
    const items = group('items', context.items.map(item => emptyCell({ id: onsiteId('block'), type: 'checklist_task', itemId: item.id, fontSize: 14, indicator: 'check' })));
    return { schemaVersion: 4, id: onsiteId('document'), root: { ...emptyCell(), sizing: { mode: 'hug' }, gap: 0, children: [
                group('expanded', [text('title', 20), text('description'), emptyCell({ id: onsiteId('block'), type: 'checklist_progress', fontSize: 12 }), items, { ...emptyCell(), direction: 'row', sizing: { mode: 'hug' }, children: [control('collapse'), control('dismiss')] }]),
                group('launcher', [emptyCell({ id: onsiteId('block'), type: 'icon', icon: 'check', size: 20 }), text('launcher-label'), text('remaining-count')]),
                group('completion', [emptyCell({ id: onsiteId('block'), type: 'icon', icon: 'check', size: 28 }), text('completion-title', 20), text('completion-description'), control('completion-acknowledge')])
            ] } };
}
export function validateOnsiteChecklistDocument(document, context) {
    const errors = [];
    const views = document.root.children ?? [];
    if (document.schemaVersion !== 4 || document.root.checklistRole || document.root.block || views.length !== 3 || !['expanded', 'launcher', 'completion'].every(role => views.filter(cell => cell.checklistRole === role).length === 1))
        errors.push('Checklist document needs exactly one Expanded, Collapsed and Completed view.');
    const expected = { title: 'expanded', description: 'expanded', progress: 'expanded', collapse: 'expanded', dismiss: 'expanded', 'launcher-label': 'launcher', 'remaining-count': 'launcher', 'completion-title': 'completion', 'completion-description': 'completion', 'completion-acknowledge': 'completion' };
    const counts = new Map(), itemCounts = new Map(), ids = new Set();
    let containers = 0;
    if (!context.items.length || context.items.length > 20)
        errors.push('A Checklist needs 1–20 tasks.');
    for (const item of context.items) {
        if (ids.has(item.id))
            errors.push('Checklist item IDs must be unique.');
        ids.add(item.id);
        if (!item.title.trim())
            errors.push('Task title cannot be empty.');
    }
    const visit = (cell, view, inItems = false) => {
        if (cell.checklistRole === 'items') {
            containers++;
            if (view !== 'expanded' || inItems)
                errors.push('Task container belongs in the Expanded view.');
            inItems = true;
        }
        if (cell.checklistRole && cell.checklistRole !== 'items' && cell !== views.find(value => value.id === cell.id))
            errors.push('Checklist views cannot be nested.');
        const block = cell.block;
        if (block?.type === 'checklist_task') {
            itemCounts.set(block.itemId, (itemCounts.get(block.itemId) ?? 0) + 1);
            if (!ids.has(block.itemId) || !inItems || view !== 'expanded')
                errors.push('Orphaned task reference or task outside the Expanded task container.');
        }
        else if (block?.type === 'checklist_text' || block?.type === 'checklist_control' || block?.type === 'checklist_progress') {
            const role = block.type === 'checklist_progress' ? 'progress' : block.role;
            counts.set(role, (counts.get(role) ?? 0) + 1);
            if (expected[role] !== view || inItems)
                errors.push('Checklist structural component is in the wrong view.');
        }
        else if (block && ['question', 'survey_controls', 'button'].includes(block.type))
            errors.push('Use Checklist controls and tasks in a Checklist document.');
        cell.children?.forEach(child => visit(child, view, inItems));
    };
    views.forEach(view => visit(view, view.checklistRole ?? ''));
    if (containers !== 1)
        errors.push('Checklist needs exactly one task container.');
    for (const role of Object.keys(expected))
        if (counts.get(role) !== 1)
            errors.push(`Checklist role ${role} must appear exactly once.`);
    for (const item of context.items)
        if (itemCounts.get(item.id) !== 1)
            errors.push(`Task ${item.id} must be referenced exactly once.`);
    const order = listBlocks(document.root).filter((block) => block.type === "checklist_task").map(block => block.itemId);
    if (JSON.stringify(order) !== JSON.stringify(context.items.map(item => item.id)))
        errors.push("Task layout order must match the canonical item order.");
    return errors;
}
export function duplicateChecklistCell(document, context, cellId) {
    const candidate = cloneOnsite(document), items = cloneOnsite(context.items), id = duplicateCell(candidate, cellId);
    if (!id)
        return null;
    for (const block of listBlocks(findCell(candidate, id)))
        if (block.type === 'checklist_task') {
            const source = items.find(item => item.id === block.itemId);
            if (!source)
                return null;
            const copy = { ...cloneOnsite(source), id: onsiteId('item') };
            block.itemId = copy.id;
            items.push(copy);
        }
    const ordered = listBlocks(candidate.root).filter((block) => block.type === 'checklist_task').map(block => items.find(item => item.id === block.itemId));
    if (validateOnsiteChecklistDocument(candidate, { ...context, items: ordered }).length || !validateOnsiteDocument(candidate).valid)
        return null;
    return { document: candidate, items: ordered, cellId: id };
}
export function onsiteDocumentFromBuilder(builder) {
    const movcues = builder?.projectData?.movcues;
    if (!movcues || typeof movcues !== "object")
        return null;
    const document = movcues.onsiteDocument;
    return isOnsiteDocument(document) ? document : null;
}
export function applyOnsiteDocument(builder, document, widgetType, survey, checklist) {
    const compiled = compileOnsiteDocument(document, widgetType, survey, checklist);
    builder.version = 1;
    builder.projectData = { ...builder.projectData, movcues: { ...asRecord(builder.projectData.movcues), authoringSurface: "onsite", schemaVersion: document.schemaVersion, onsiteDocument: document, actionBindings: compiled.actionBindings } };
    builder.html = compiled.html;
    builder.css = compiled.css;
    return compiled;
}
export function rawOnsiteDocument(builder) {
    const movcues = builder?.projectData?.movcues;
    return movcues && typeof movcues === "object" ? movcues.onsiteDocument : undefined;
}
export function validateCompiledOnsiteBuilder(builder, content, widgetType, guide, survey, checklist) {
    if (isSourceAuthored(builder)) {
        const movcues = builder.projectData.movcues;
        const bindings = movcues.actionBindings && typeof movcues.actionBindings === "object" ? movcues.actionBindings : {};
        const errors = validateSourceMarkup({ html: builder.html, css: builder.css, actionBindings: bindings }, {
            widgetType, guide, editable: movcues.sourceEditabilityVersion === 1,
            survey: survey ? { questions: survey.questions, submitLabel: survey.submitLabel } : undefined,
            checklist: checklist ? { items: checklist.items.map(item => ({ id: item.id })) } : undefined,
        });
        if (JSON.stringify(sourceContentProjection(builder.html, content)) !== JSON.stringify(content))
            errors.push("Source-authored content projection is inconsistent.");
        return errors;
    }
    const raw = rawOnsiteDocument(builder);
    if (raw === undefined)
        return [];
    const result = validateOnsiteDocument(raw);
    if (!result.valid)
        return result.errors;
    const document = raw;
    let compiled;
    try {
        compiled = compileOnsiteDocument(document, widgetType, survey, checklist);
    }
    catch (error) {
        return [error instanceof Error ? error.message : "Invalid Survey document."];
    }
    const errors = [];
    if (builder.html !== compiled.html)
        errors.push("Compiled on-site HTML does not match the structured document.");
    if (builder.css !== compiled.css)
        errors.push("Compiled on-site CSS does not match the structured document.");
    const movcues = builder.projectData.movcues;
    if (JSON.stringify(movcues.actionBindings) !== JSON.stringify(compiled.actionBindings))
        errors.push("Compiled on-site action binding map does not match the structured document.");
    if (JSON.stringify(content) !== JSON.stringify(compiled.content))
        errors.push("Structured content does not match the compiled on-site document projection.");
    for (const block of listBlocks(document.root))
        if (block.type === "button" && !guide && (block.action.type === "next_step" || block.action.type === "previous_step"))
            errors.push(`${block.action.type} is only supported by Guides.`);
    return errors;
}
export function compileOnsiteDocument(document, widgetType, survey, checklist) {
    const validation = validateOnsiteDocument(document);
    if (!validation.valid)
        throw new Error(validation.errors.join(" "));
    if (document.schemaVersion === 4) {
        if (widgetType !== "checklist" || !checklist || survey)
            throw new Error("Version 4 requires a Checklist context.");
        const errors = validateOnsiteChecklistDocument(document, checklist);
        if (errors.length)
            throw new Error(errors.join(" "));
    }
    else if (checklist)
        throw new Error("Checklist cells require document version 4.");
    if (document.schemaVersion === 3) {
        if (widgetType !== "survey" || !survey)
            throw new Error("Version 3 requires a Survey question context.");
        const errors = validateOnsiteSurveyDocument(document, survey);
        if (errors.length)
            throw new Error(errors.join(" "));
    }
    else if (survey)
        throw new Error("Survey cells require document version 3.");
    const css = [
        ".movcues-widget{box-sizing:border-box;width:100%;max-width:100%;min-width:0;overflow-wrap:anywhere;padding:var(--movcues-theme-spacing,0);background:var(--movcues-bg);color:var(--movcues-fg);border-color:var(--movcues-border,transparent);border-radius:var(--movcues-theme-radius,inherit);font-family:var(--movcues-font-body,ui-sans-serif,system-ui,sans-serif);font-size:var(--movcues-font-body-size,15px);box-shadow:var(--movcues-theme-shadow,none)}",
        ".movcues-widget *{box-sizing:border-box}",
        ".movcues-widget .movcues-cell{display:flex;min-width:0;max-width:100%}",
        ".movcues-widget .movcues-block{min-width:0;max-width:100%;margin:0}",
        ".movcues-widget .movcues-block img{display:block;max-width:100%}",
        ".movcues-widget .movcues-heading{font-family:var(--movcues-font-heading,var(--movcues-font-body));font-size:var(--movcues-font-heading-size,inherit)}",
        ".movcues-widget .movcues-button{min-height:40px;border:0;border-radius:var(--movcues-button-radius,8px);font:600 14px/1.2 var(--movcues-font-body,ui-sans-serif,system-ui,sans-serif);cursor:pointer}",
        ".movcues-widget .movcues-button--primary{background:var(--movcues-primary);color:var(--movcues-primary-fg,#fff)}",
        ".movcues-widget .movcues-button--secondary{background:transparent;color:inherit}",
        ".movcues-widget .movcues-button--outline{background:transparent;color:inherit;border:1px solid currentColor}",
        ".movcues-widget .movcues-block--full{width:100%}",
    ];
    if (document.schemaVersion === 3)
        css.push(SURVEY_CELL_CSS);
    if (document.schemaVersion === 4)
        css.push(CHECKLIST_CELL_CSS);
    const html = renderCell(document.root, css, 0, survey, checklist);
    css.push("@media(max-width:480px){.movcues-widget [data-movcues-responsive-stack=\"true\"]{flex-direction:column!important}.movcues-widget [data-movcues-sizing=\"fixed\"]{max-width:100%!important}.movcues-widget .movcues-button{min-height:40px}.movcues-widget img{height:auto!important}}");
    const blocks = listBlocks(document.root);
    const firstHeading = blocks.find(block => block.type === "heading");
    const text = blocks.filter(block => block.type === "text").map(block => richTextToPlain(block.html)).join("\n").slice(0, 2_000);
    const actions = blocks.filter(block => block.type === "button");
    const actionBindings = Object.fromEntries(actions.map(block => [block.action.id, block.action]));
    const legacy = actions.slice(0, 2).map(block => ({ label: block.label, type: block.action.type === "previous_step" ? "dismiss" : block.action.type, ...("url" in block.action ? { url: block.action.url } : {}), ...("eventName" in block.action ? { eventName: block.action.eventName } : {}) }));
    const content = {
        heading: checklist ? checklist.title : firstHeading ? richTextToPlain(firstHeading.html).slice(0, 160) : "",
        body: checklist ? checklist.description ?? "" : text,
        ...(legacy[0] ? { primaryAction: legacy[0] } : {}),
        ...(legacy[1]?.type === "dismiss" ? { secondaryAction: { label: legacy[1].label, type: "dismiss" } } : {}),
    };
    return { html: `<section class="movcues-widget movcues-widget--${escapeAttribute(widgetType)}" data-movcues-widget-type="${escapeAttribute(widgetType)}" data-movcues-document-version="${document.schemaVersion}"${checklist ? ' data-movcues-checklist-role="root"' : ""}>${html}</section>`, css: css.join(""), content, actionBindings };
}
function renderCell(cell, css, depth, survey, checklist) {
    const selector = `.movcues-widget [data-movcues-node-id="${cell.id}"]`;
    const sizing = cell.sizing.mode === "flexible" ? `flex:${round(cell.sizing.weight)} 1 0` : cell.sizing.mode === "hug" ? "flex:0 0 auto" : `flex:0 1 ${cell.sizing.value}px`;
    const style = cell.style ?? {};
    css.push(`${selector}{${sizing};flex-direction:${cell.direction};align-items:${cell.align};justify-content:${cell.justify};gap:${cell.gap}px;padding:${cell.padding.top}px ${cell.padding.right}px ${cell.padding.bottom}px ${cell.padding.left}px;${style.background ? `background:${style.background};` : ""}${style.borderWidth ? `border:${style.borderWidth}px solid ${style.borderColor ?? "#dbe2ea"};` : ""}${style.borderRadius ? `border-radius:${style.borderRadius}px;` : ""}}`);
    if (cell.checklistWidth !== undefined)
        css.push(`.movcues-widget--checklist:has([data-movcues-node-id="${cell.id}"].is-active){width:${cell.checklistWidth}px}`);
    const children = cell.children?.map(child => renderCell(child, css, depth + 1, survey, checklist)).join("") ?? (cell.block ? renderBlock(cell.block, css, survey, checklist) : "");
    return `<div class="movcues-cell" data-movcues-node-id="${cell.id}"${cell.checklistRole ? cell.checklistRole === "items" ? ' data-movcues-checklist-role="items"' : ` data-movcues-checklist-view="${cell.checklistRole}"` : ""} data-movcues-sizing="${cell.sizing.mode}"${cell.responsiveStack ? ' data-movcues-responsive-stack="true"' : ""}>${children}</div>`;
}
function renderBlock(block, css, survey, checklist) {
    const selector = `.movcues-widget [data-movcues-block-id="${block.id}"]`;
    const align = block.align ?? "left";
    if ((block.type === "checklist_task" || block.type === "checklist_text" || block.type === "checklist_control" || block.type === "checklist_progress")) {
        if (!checklist)
            throw new Error("Checklist component needs canonical context.");
        const item = block;
        css.push(`${selector}{font-size:${item.fontSize}px;text-align:${align};${item.color ? `color:${item.color};` : ""}}`);
        const attrs = `class="movcues-block" data-movcues-block-id="${block.id}"`;
        if (item.type === "checklist_task") {
            const task = checklist.items.find(value => value.id === item.itemId);
            return `<button type="button" class="movcues-block movcues-checklist__item" data-movcues-block-id="${item.id}" data-movcues-checklist-role="item" data-movcues-checklist-item-id="${escapeChecklist(task.id)}"><span data-movcues-checklist-item-role="state">${ICONS[item.indicator]}</span><span class="movcues-checklist__copy"><span data-movcues-checklist-item-role="title">${escapeChecklist(task.title)}</span><span data-movcues-checklist-item-role="description">${escapeChecklist(task.description ?? "")}</span></span></button>`;
        }
        if (item.type === "checklist_text")
            return `<div ${attrs} data-movcues-checklist-role="${item.role}">${escapeChecklist(item.role === "launcher-label" && item.text !== undefined ? item.text : checklistCopy(checklist)[item.role])}</div>`;
        if (item.type === "checklist_control")
            return `<button type="button" class="movcues-block movcues-checklist-control" data-movcues-block-id="${item.id}" data-movcues-checklist-role="${item.role}" aria-label="${item.role === "collapse" ? "Collapse checklist" : item.role === "dismiss" ? "Dismiss checklist" : "Acknowledge completion"}">${escapeChecklist(item.role === "collapse" ? "−" : item.role === "dismiss" ? "×" : checklist.completionMessage.acknowledgeLabel)}</button>`;
        return `<div ${attrs}><div data-movcues-checklist-role="progress"></div><div class="movcues-checklist-progress-track"><span class="movcues-checklist-progress-fill"></span></div></div>`;
    }
    if (block.type === "question") {
        css.push(`${selector}{font:${block.fontSize}px/1.5 var(--movcues-font-body,ui-sans-serif,system-ui,sans-serif);text-align:${align};${block.color ? `color:${block.color};` : ""}}`);
        return surveyQuestionMarkup(survey.questions.find(question => question.id === block.questionId), block.id);
    }
    if (block.type === "survey_controls")
        return surveyControlsMarkup(block.id, survey?.submitLabel ?? "Submit");
    if (block.type === "heading") {
        css.push(`${selector}{font:${block.weight} ${block.fontSize}px/${block.lineHeight ?? 1.25} var(--movcues-font-heading,ui-sans-serif,system-ui,sans-serif);text-align:${align};${block.color ? `color:${block.color};` : ""}}`);
        return `<h${block.level} class="movcues-block movcues-heading" data-movcues-block-id="${block.id}" data-movcues-content="heading">${sanitizeRichText(block.html)}</h${block.level}>`;
    }
    if (block.type === "text") {
        css.push(`${selector}{font:${block.weight} ${block.fontSize}px/${block.lineHeight ?? 1.5} var(--movcues-font-body,ui-sans-serif,system-ui,sans-serif);text-align:${align};white-space:pre-wrap;${block.color ? `color:${block.color};` : ""}}`);
        return `<div class="movcues-block movcues-text" data-movcues-block-id="${block.id}" data-movcues-content="body">${sanitizeRichText(block.html)}</div>`;
    }
    if (block.type === "button") {
        css.push(`${selector}{align-self:${align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center"};padding:${block.paddingY}px ${block.paddingX}px;border-radius:${block.radius}px;${block.width === "full" ? "width:100%;" : ""}${block.background ? `background:${block.background};` : ""}${block.color ? `color:${block.color};` : ""}}`);
        return `<button type="button" class="movcues-block movcues-button movcues-button--${block.variant}${block.width === "full" ? " movcues-block--full" : ""}" data-movcues-block-id="${block.id}" data-movcues-action-id="${block.action.id}">${escapeText(block.label)}</button>`;
    }
    if (block.type === "image") {
        css.push(`${selector}{align-self:${align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center"};width:${block.width}%;${block.height ? `height:${block.height}px;` : "height:auto;"}object-fit:${block.fit};border-radius:${block.radius}px}`);
        return `<img class="movcues-block movcues-image" data-movcues-block-id="${block.id}" src="${escapeAttribute(block.src)}" alt="${escapeAttribute(block.alt)}">`;
    }
    if (block.type === "divider") {
        css.push(`${selector}{align-self:stretch;${block.orientation === "horizontal" ? `width:100%;height:${block.thickness}px` : `width:${block.thickness}px;min-height:24px`};border:0;background:${block.color}}`);
        return `<hr class="movcues-block movcues-divider" data-movcues-block-id="${block.id}">`;
    }
    if (block.type === "spacer") {
        css.push(`${selector}{flex:0 0 ${block.size}px;width:${block.size}px;height:${block.size}px}`);
        return `<div class="movcues-block movcues-spacer" data-movcues-block-id="${block.id}" aria-hidden="true"></div>`;
    }
    css.push(`${selector}{align-self:${align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center"};font-size:${block.size}px;line-height:1;${block.color ? `color:${block.color};` : ""}}`);
    return `<span class="movcues-block movcues-icon" data-movcues-block-id="${block.id}" role="img" aria-label="${block.icon}">${ICONS[block.icon]}</span>`;
}
export function validateOnsiteDocument(value) {
    const errors = [];
    if (!isOnsiteDocumentShape(value))
        return { valid: false, errors: ["On-site document must use schemaVersion 2, 3 or 4 and contain one root cell."] };
    unexpectedKeys(value, ["schemaVersion", "id", "root"], "Document", errors);
    const ids = new Set();
    const seen = new Set();
    let count = 0;
    const addId = (id, path) => { if (typeof id !== "string" || !ID_PATTERN.test(id))
        errors.push(`${path} has an invalid ID.`);
    else if (ids.has(id))
        errors.push(`${path} reuses ID ${id}.`);
    else
        ids.add(id); };
    const number = (input, min, max, path) => { if (typeof input !== "number" || !Number.isFinite(input) || input < min || input > max)
        errors.push(`${path} must be between ${min} and ${max}.`); };
    addId(value.id, "Document");
    const visit = (cell, depth, path) => {
        if (!cell || typeof cell !== "object") {
            errors.push(`${path} must be a cell object.`);
            return;
        }
        if (seen.has(cell)) {
            errors.push(`${path} creates a cycle or duplicate reference.`);
            return;
        }
        seen.add(cell);
        count++;
        addId(cell.id, path);
        unexpectedKeys(cell, ["type", "id", "checklistRole", "checklistWidth", "direction", "sizing", "align", "justify", "gap", "padding", "responsiveStack", "style", "children", "block"], path, errors);
        if (depth > ONSITE_LIMITS.maxDepth)
            errors.push(`${path} exceeds maximum nesting depth ${ONSITE_LIMITS.maxDepth}.`);
        if (!["row", "column"].includes(cell.direction))
            errors.push(`${path} has an invalid direction.`);
        if (!["start", "center", "end", "stretch"].includes(cell.align))
            errors.push(`${path} has an invalid alignment.`);
        if (!["start", "center", "end", "space-between"].includes(cell.justify))
            errors.push(`${path} has an invalid distribution.`);
        if (cell.responsiveStack !== undefined && typeof cell.responsiveStack !== "boolean")
            errors.push(`${path} responsiveStack must be a boolean.`);
        number(cell.gap, 0, 96, `${path} gap`);
        for (const side of ["top", "right", "bottom", "left"])
            number(cell.padding?.[side], 0, 128, `${path} padding ${side}`);
        if (cell.sizing?.mode === "flexible")
            number(cell.sizing.weight, 0.1, 20, `${path} flexible weight`);
        else if (cell.sizing?.mode === "fixed")
            number(cell.sizing.value, ONSITE_LIMITS.minFixedSize, ONSITE_LIMITS.maxFixedSize, `${path} fixed size`);
        else if (cell.sizing?.mode !== "hug")
            errors.push(`${path} has an invalid sizing mode.`);
        if (cell.sizing && typeof cell.sizing === "object")
            unexpectedKeys(cell.sizing, cell.sizing.mode === "flexible" ? ["mode", "weight"] : cell.sizing.mode === "fixed" ? ["mode", "value"] : ["mode"], `${path} sizing`, errors);
        if (cell.style) {
            unexpectedKeys(cell.style, ["background", "borderColor", "borderWidth", "borderRadius"], `${path} style`, errors);
            if (cell.style.background && !COLOR_PATTERN.test(cell.style.background))
                errors.push(`${path} background is not supported.`);
            if (cell.style.borderColor && !COLOR_PATTERN.test(cell.style.borderColor))
                errors.push(`${path} border color is not supported.`);
            if (cell.style.borderWidth !== undefined)
                number(cell.style.borderWidth, 0, 16, `${path} border width`);
            if (cell.style.borderRadius !== undefined)
                number(cell.style.borderRadius, 0, 100, `${path} border radius`);
        }
        if (cell.children && cell.block)
            errors.push(`${path} cannot contain both children and a block.`);
        if (cell.children) {
            if (!cell.children.length)
                errors.push(`${path} cannot contain an empty children list.`);
            cell.children.forEach((child, index) => visit(child, depth + 1, `${path} > cell ${index + 1}`));
        }
        if (cell.checklistWidth !== undefined && (value.schemaVersion !== 4 || !["expanded", "launcher", "completion"].includes(cell.checklistRole ?? "") || !Number.isInteger(cell.checklistWidth) || cell.checklistWidth < 120 || cell.checklistWidth > 720))
            errors.push(`${path} view width must be 120–720 pixels.`);
        if (cell.checklistRole !== undefined && (value.schemaVersion !== 4 || !["expanded", "launcher", "completion", "items"].includes(cell.checklistRole)))
            errors.push(`${path} has an invalid Checklist container.`);
        if (cell.block?.type.startsWith("checklist_") && value.schemaVersion !== 4)
            errors.push("Checklist blocks require schemaVersion 4.");
        if (cell.block && value.schemaVersion === 2 && ["question", "survey_controls"].includes(cell.block.type))
            errors.push("Survey blocks require schemaVersion 3.");
        if (cell.block)
            validateBlock(cell.block, `${path} block`, addId, number, errors);
    };
    try {
        visit(value.root, 1, "Root cell");
    }
    catch {
        errors.push("Document contains malformed cell or block values.");
    }
    if (count > ONSITE_LIMITS.maxNodes)
        errors.push(`Document has ${count} cells; maximum is ${ONSITE_LIMITS.maxNodes}.`);
    try {
        if (new TextEncoder().encode(JSON.stringify(value)).byteLength > ONSITE_LIMITS.maxSerializedBytes)
            errors.push(`Document exceeds ${ONSITE_LIMITS.maxSerializedBytes} serialized bytes.`);
    }
    catch {
        errors.push("Document cannot be serialized.");
    }
    return { valid: errors.length === 0, errors };
}
function validateBlock(block, path, addId, number, errors) {
    addId(block.id, path);
    const base = ["id", "type", "align"];
    const keys = { checklist_task: [...base, "itemId", "fontSize", "color", "indicator"], checklist_text: [...base, "role", "fontSize", "color", "text"], checklist_control: [...base, "role", "fontSize", "color"], checklist_progress: [...base, "fontSize", "color"], question: [...base, "questionId", "fontSize", "color"], survey_controls: base, heading: [...base, "html", "level", "fontSize", "weight", "color", "lineHeight"], text: [...base, "html", "fontSize", "weight", "color", "lineHeight"], button: [...base, "label", "action", "variant", "background", "color", "radius", "paddingX", "paddingY", "width"], image: [...base, "src", "alt", "fit", "width", "height", "radius"], divider: [...base, "orientation", "thickness", "color"], spacer: [...base, "size"], icon: [...base, "icon", "size", "color"] };
    if (!Object.prototype.hasOwnProperty.call(keys, block.type)) {
        errors.push(`${path} has an unsupported block type.`);
        return;
    }
    unexpectedKeys(block, keys[block.type], path, errors);
    if (block.align !== undefined && !["left", "center", "right"].includes(block.align))
        errors.push(`${path} has an invalid alignment.`);
    if ((block.type === "checklist_task" || block.type === "checklist_text" || block.type === "checklist_control" || block.type === "checklist_progress")) {
        const item = block;
        number(item.fontSize, 10, 48, `${path} font size`);
        if (item.type === "checklist_task" && (typeof item.itemId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.itemId) || !(item.indicator in ICONS)))
            errors.push(`${path} has an invalid task reference or indicator.`);
        if (item.type === "checklist_text" && (!["title", "description", "launcher-label", "remaining-count", "completion-title", "completion-description"].includes(item.role) || (item.text !== undefined && (item.role !== "launcher-label" || typeof item.text !== "string" || !item.text.trim() || item.text.length > 200))))
            errors.push(`${path} has an invalid Checklist text role.`);
        if (item.type === "checklist_control" && !["collapse", "dismiss", "completion-acknowledge"].includes(item.role))
            errors.push(`${path} has an invalid Checklist control.`);
    }
    else if (block.type === "question") {
        if (typeof block.questionId !== "string" || !block.questionId.trim() || block.questionId.length > 64)
            errors.push(`${path} must reference a stable question ID.`);
        number(block.fontSize, 10, 36, `${path} font size`);
    }
    else if (block.type === "heading" || block.type === "text") {
        if (typeof block.html !== "string" || block.html.length > ONSITE_LIMITS.maxRichText || sanitizeRichText(block.html) !== block.html)
            errors.push(`${path} contains unsupported or unsafe rich text.`);
        number(block.fontSize, 10, 72, `${path} font size`);
        number(block.lineHeight ?? 1.4, 0.9, 3, `${path} line height`);
        if (![400, 500, 600, 700].includes(block.weight))
            errors.push(`${path} has an invalid font weight.`);
        if (block.type === "heading" && ![1, 2, 3, 4].includes(block.level))
            errors.push(`${path} has an invalid heading level.`);
    }
    else if (block.type === "button") {
        if (!block.label?.trim() || block.label.length > 80)
            errors.push(`${path} label must contain 1–80 characters.`);
        addId(block.action?.id, `${path} action`);
        if (!block.action || !["next_step", "previous_step", "dismiss", "open_url", "track_event"].includes(block.action.type))
            errors.push(`${path} has an invalid action.`);
        else
            unexpectedKeys(block.action, block.action.type === "open_url" ? ["id", "type", "url"] : block.action.type === "track_event" ? ["id", "type", "eventName"] : ["id", "type"], `${path} action`, errors);
        if (block.action?.type === "open_url" && (!builderLinkUrlIsSafe(block.action.url) || !/^https?:\/\//i.test(block.action.url)))
            errors.push(`${path} URL must use HTTP(S).`);
        if (block.action?.type === "track_event" && (!block.action.eventName?.trim() || block.action.eventName.length > 200))
            errors.push(`${path} custom event must contain 1–200 characters.`);
        if (!["primary", "secondary", "outline"].includes(block.variant))
            errors.push(`${path} has an invalid variant.`);
        if (!["hug", "full"].includes(block.width))
            errors.push(`${path} has an invalid width behavior.`);
        number(block.radius, 0, 48, `${path} radius`);
        number(block.paddingX, 4, 48, `${path} horizontal padding`);
        number(block.paddingY, 4, 32, `${path} vertical padding`);
    }
    else if (block.type === "image") {
        if (!onsiteImageSourceIsSafe(block.src))
            errors.push(`${path} image must use a safe URL (up to 2,000 characters) or a small PNG, JPEG, WebP or GIF image (up to 64 KB encoded).`);
        if (block.alt.length > 500)
            errors.push(`${path} alt text exceeds 500 characters.`);
        if (!["contain", "cover"].includes(block.fit))
            errors.push(`${path} has an invalid image fit.`);
        number(block.width, 1, 100, `${path} width`);
        if (block.height !== undefined)
            number(block.height, 24, 1_200, `${path} height`);
        number(block.radius, 0, 100, `${path} radius`);
    }
    else if (block.type === "divider") {
        if (!["horizontal", "vertical"].includes(block.orientation))
            errors.push(`${path} has an invalid divider orientation.`);
        number(block.thickness, 1, 16, `${path} thickness`);
    }
    else if (block.type === "spacer")
        number(block.size, 4, 240, `${path} size`);
    else if (block.type === "icon") {
        if (!(block.icon in ICONS))
            errors.push(`${path} icon is not supported.`);
        number(block.size, 12, 96, `${path} size`);
    }
    if ("color" in block && block.color && !COLOR_PATTERN.test(block.color))
        errors.push(`${path} color is not supported.`);
}
export function onsiteImageSourceIsSafe(src) {
    if (typeof src !== "string")
        return false;
    if (!/^data:/i.test(src))
        return src.length <= ONSITE_LIMITS.maxImageUrl && builderImageUrlIsSafe(src);
    if (src.length > ONSITE_LIMITS.maxInlineImage)
        return false;
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(src);
    if (!match || match[2].length % 4 !== 0)
        return false;
    try {
        const bytes = atob(match[2]);
        switch (match[1].toLowerCase()) {
            case "png": return bytes.startsWith("\x89PNG\r\n\x1a\n");
            case "jpeg": return bytes.startsWith("\xff\xd8\xff");
            case "webp": return bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
            case "gif": return bytes.startsWith("GIF87a") || bytes.startsWith("GIF89a");
        }
    }
    catch { /* Invalid base64 must never become authored content. */ }
    return false;
}
function unexpectedKeys(value, allowed, path, errors) { const extra = Object.keys(value).filter(key => !allowed.includes(key)); if (extra.length)
    errors.push(`${path} contains unsupported fields: ${extra.join(", ")}.`); }
export function findCell(document, id) { let found = null; walkCells(document.root, cell => { if (cell.id === id)
    found = cell; }); return found; }
export function findBlock(document, id) { let found = null; walkCells(document.root, cell => { if (cell.block?.id === id)
    found = cell.block; }); return found; }
export function parentCell(document, id) { let found = null; walkCells(document.root, cell => { if (cell.children?.some(child => child.id === id))
    found = cell; }); return found; }
export function cellForBlock(document, id) { let found = null; walkCells(document.root, cell => { if (cell.block?.id === id)
    found = cell; }); return found; }
export function listBlocks(cell) { const blocks = []; walkCells(cell, item => { if (item.block)
    blocks.push(item.block); }); return blocks; }
function walkCells(cell, visit) { visit(cell); cell.children?.forEach(child => walkCells(child, visit)); }
export function splitCell(document, cellId, direction) {
    const cell = findCell(document, cellId);
    if (!cell || cell.children)
        return null;
    const preserved = emptyCell(cell.block);
    const added = emptyCell();
    delete cell.block;
    cell.children = [preserved, added];
    cell.direction = direction;
    cell.responsiveStack = direction === "row";
    return added.id;
}
export function insertEdgeCell(document, edge) {
    const wanted = edge === "left" || edge === "right" ? "row" : "column";
    const added = emptyCell();
    if (document.root.children && document.root.direction === wanted && !document.root.block)
        document.root.children[edge === "top" || edge === "left" ? "unshift" : "push"](added);
    else {
        const old = structuredCloneSafe(document.root);
        old.id = onsiteId("cell");
        document.root = { ...emptyCell(), id: document.root.id, direction: wanted, responsiveStack: wanted === "row", children: edge === "top" || edge === "left" ? [added, old] : [old, added] };
    }
    return added.id;
}
export function removeCell(document, id) {
    const parent = parentCell(document, id);
    if (!parent?.children || parent.children.length <= 1) {
        const cell = findCell(document, id);
        if (!cell || cell === document.root)
            return false;
        delete cell.block;
        return true;
    }
    parent.children = parent.children.filter(child => child.id !== id);
    if (parent.children.length === 1)
        collapseSingleChild(parent);
    return true;
}
export function moveCell(document, id, delta) { const parent = parentCell(document, id); if (!parent?.children)
    return false; const index = parent.children.findIndex(child => child.id === id); const next = index + delta; if (index < 0 || next < 0 || next >= parent.children.length)
    return false; [parent.children[index], parent.children[next]] = [parent.children[next], parent.children[index]]; return true; }
export function resizeSiblings(document, firstId, secondId, firstWeight) { const parent = parentCell(document, firstId); if (!parent?.children || parent !== parentCell(document, secondId))
    return false; const a = parent.children.find(child => child.id === firstId); const b = parent.children.find(child => child.id === secondId); if (!a || !b)
    return false; const bounded = Math.max(0.1, Math.min(1.9, Math.round(firstWeight * 20) / 20)); a.sizing = { mode: "flexible", weight: bounded }; b.sizing = { mode: "flexible", weight: 2 - bounded }; return true; }
export function duplicateCell(document, id) { const source = findCell(document, id); const parent = parentCell(document, id); if (!source || !parent?.children)
    return null; const copy = structuredCloneSafe(source); regenerateIds(copy); const index = parent.children.findIndex(child => child.id === id); parent.children.splice(index + 1, 0, copy); return copy.id; }
function regenerateIds(cell) { cell.id = onsiteId("cell"); if (cell.block) {
    cell.block.id = onsiteId("block");
    if (cell.block.type === "button")
        cell.block.action.id = onsiteId("action");
} cell.children?.forEach(regenerateIds); }
function collapseSingleChild(cell) { if (cell.checklistRole)
    return; const child = cell.children?.[0]; if (!child)
    return; const id = cell.id; Object.assign(cell, child, { id }); }
export function duplicateDocument(document) { const copy = structuredCloneSafe(document); copy.id = onsiteId("document"); regenerateIds(copy.root); return copy; }
export function cloneOnsite(value) { return structuredCloneSafe(value); }
function structuredCloneSafe(value) { return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
export function sanitizeRichText(input) { return richTextIsSafe(input) ? input : ""; }
function richTextIsSafe(input) {
    let valid = true;
    const fragment = parseFragment(input, { sourceCodeLocationInfo: true, onParseError: () => { valid = false; } });
    const visit = (node, ancestors = []) => {
        if (!("tagName" in node)) {
            if ("childNodes" in node)
                node.childNodes.forEach(child => visit(child, ancestors));
            return;
        }
        const tag = node.tagName.toUpperCase();
        if (!SAFE_INLINE_TAGS.has(tag)) {
            valid = false;
            return;
        }
        if (tag === "A" && ancestors.includes("A"))
            valid = false;
        for (const attr of node.attrs) {
            if (tag !== "A" || !["href", "target", "rel"].includes(attr.name) || /^on/i.test(attr.name))
                valid = false;
            if (attr.name === "href" && !builderLinkUrlIsSafe(attr.value))
                valid = false;
            if (attr.name === "target" && !["_blank", "_self"].includes(attr.value))
                valid = false;
            if (attr.name === "rel" && !/^(?:noopener|noreferrer|nofollow|\s)+$/i.test(attr.value))
                valid = false;
        }
        const attrs = new Map(node.attrs.map(attr => [attr.name, attr.value]));
        if (tag === "A" && attrs.get("target") === "_blank" && !["noopener", "noreferrer"].every(token => attrs.get("rel")?.split(/\s+/).includes(token)))
            valid = false;
        node.childNodes.forEach(child => visit(child, [...ancestors, tag]));
    };
    visit(fragment);
    return valid;
}
function richTextToPlain(input) {
    const fragment = parseFragment(input);
    const read = (node) => {
        if ("value" in node)
            return node.value;
        if (!("childNodes" in node))
            return "";
        let value = "";
        for (const child of node.childNodes) {
            if ("tagName" in child && child.tagName === "br")
                value += "\n";
            else {
                value += read(child);
                if ("tagName" in child && child.tagName === "li")
                    value += "\n";
            }
        }
        return value;
    };
    return read(fragment).trim();
}
function isOnsiteDocument(value) { return isOnsiteDocumentShape(value) && validateOnsiteDocument(value).valid; }
function isOnsiteDocumentShape(value) { return !!value && typeof value === "object" && [2, 3, 4].includes(value.schemaVersion) && !!value.root && value.root.type === "cell"; }
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function escapeText(value) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escapeAttribute(value) { return escapeText(value).replace(/"/g, "&quot;"); }
function round(value) { return String(Math.round(value * 100) / 100); }
//# sourceMappingURL=onsiteDocument.js.map