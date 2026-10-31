import { SOURCE_EDITABILITY, sourceEditabilityErrors } from "./sourceEditability.js";
import { sourceEditingCssErrors } from "./sourceStyles.js";
import { parseFragment } from "parse5";
import postcss from "postcss";
import { builderCssIsSafe, builderHtmlIsSafe } from "./builderContentContract.js";
const actionIdPattern = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const safeEventPattern = /^[^\u0000-\u001f\u007f]{1,200}$/;
const allowedAtRules = new Set(["media"]);
function attribute(element, name) { return element.attrs.find(value => value.name === name)?.value; }
function hasClass(element, name) { return (attribute(element, "class") ?? "").split(/\s+/).includes(name); }
function htmlFacts(html) {
    const fragment = parseFragment(html);
    const elements = [];
    const walk = (node) => {
        if ("tagName" in node)
            elements.push(node);
        if ("childNodes" in node)
            node.childNodes.forEach(walk);
    };
    walk(fragment);
    const roots = elements.filter(element => hasClass(element, "movcues-widget"));
    const ids = elements.map(element => attribute(element, "id")).filter((value) => Boolean(value));
    const actionIds = elements.filter(element => element.tagName === "button" && !attribute(element, "data-movcues-survey-action") && !attribute(element, "data-movcues-option-id") && !attribute(element, "data-movcues-checklist-role") && !attribute(element, "data-movcues-checklist-item-role")).map(element => attribute(element, "data-movcues-action-id"));
    const topLevelElements = fragment.childNodes.filter((node) => "tagName" in node);
    const nonWhitespaceText = fragment.childNodes.some(node => "value" in node && node.value.trim());
    return { elements, roots, ids, actionIds, topLevelElements, nonWhitespaceText };
}
/** Parses the complete stylesheet before enforcing root scoping on every style rule. */
export function sourceCssErrors(css) {
    if (css.length > 100_000)
        return ["Source CSS exceeds 100 KB."];
    let root;
    try {
        root = postcss.parse(css);
    }
    catch {
        return ["Source CSS is not valid CSS."];
    }
    const errors = [];
    root.walkAtRules(rule => { if (!allowedAtRules.has(rule.name.toLowerCase()))
        errors.push(`CSS @${rule.name} is not supported.`); });
    root.walkRules(rule => {
        for (const selector of rule.selectors) {
            const normalized = selector.trim();
            if (!/^(?:\.movcues-widget(?:\b|[.#:[>+~\s])|:where\(\.movcues-widget\)|:is\(\.movcues-widget\))/i.test(normalized))
                errors.push(`Unscoped selector: ${selector}`);
        }
    });
    root.walkDecls(declaration => {
        const property = declaration.prop.toLowerCase(), value = declaration.value;
        if (["animation", "transition"].includes(property))
            errors.push(`CSS ${property} declarations are not supported.`);
        if (["behavior", "-moz-binding"].includes(property) || /expression\s*\(|javascript\s*:/i.test(value))
            errors.push(`Unsafe CSS declaration: ${declaration.prop}`);
        if (/url\s*\(/i.test(value))
            errors.push("CSS url() values are not supported.");
    });
    if (!builderCssIsSafe(css) && !errors.length)
        errors.push("Source CSS contains an unsafe construct or unscoped selector.");
    return [...new Set(errors)];
}
function count(elements, name, value) {
    return elements.filter(element => attribute(element, name) !== undefined && (value === undefined || attribute(element, name) === value)).length;
}
export function validateSourceMarkup(input, options) {
    const errors = [];
    if (input.html.length > 100_000)
        errors.push("Source HTML exceeds 100 KB.");
    if (!builderHtmlIsSafe(input.html, Boolean(options.survey)))
        errors.push("Source HTML contains unsupported or unsafe markup.");
    errors.push(...sourceCssErrors(input.css));
    const facts = htmlFacts(input.html);
    if (facts.roots.length !== 1)
        errors.push("Source HTML must contain exactly one .movcues-widget root.");
    const root = facts.roots[0];
    if (facts.topLevelElements.length !== 1 || facts.topLevelElements[0] !== root || facts.nonWhitespaceText)
        errors.push("The .movcues-widget root must be the sole top-level element.");
    if (root && attribute(root, "data-movcues-widget-type") !== options.widgetType)
        errors.push("The widget root type cannot be changed.");
    if (root && !attribute(root, "data-movcues-document-version"))
        errors.push("The widget root must preserve data-movcues-document-version.");
    if (new Set(facts.ids).size !== facts.ids.length)
        errors.push("Source HTML contains duplicate element IDs.");
    if (facts.actionIds.some(value => !value || !actionIdPattern.test(value)))
        errors.push("Every button must have a valid data-movcues-action-id.");
    const usedActions = facts.actionIds.filter((value) => Boolean(value));
    if (new Set(usedActions).size !== usedActions.length)
        errors.push("Functional action IDs must be unique in the source HTML.");
    const bindingIds = Object.keys(input.actionBindings);
    if (bindingIds.some(value => !actionIdPattern.test(value)) || new Set(bindingIds).size !== bindingIds.length)
        errors.push("The action binding map contains invalid IDs.");
    if (usedActions.length !== bindingIds.length || usedActions.some(value => !Object.hasOwn(input.actionBindings, value)))
        errors.push("Every button action must resolve exactly once, without orphan bindings.");
    for (const action of Object.values(input.actionBindings)) {
        if (!options.guide && (action.type === "next_step" || action.type === "previous_step"))
            errors.push(`${action.type} is only supported by Guides.`);
        if (action.type === "open_url" && !/^https?:\/\//i.test(action.url))
            errors.push("Open URL actions must use HTTP(S).");
        if (action.type === "track_event" && (!action.eventName.trim() || !safeEventPattern.test(action.eventName)))
            errors.push("Track-event actions require a safe event name.");
    }
    if (options.survey) {
        for (const question of options.survey.questions) {
            const matches = facts.elements.filter(element => attribute(element, "data-movcues-question-id") === question.id);
            if (matches.length !== 1 || attribute(matches[0], "data-movcues-question-type") !== question.type)
                errors.push(`Survey question ${question.id} must remain exactly once with its canonical type.`);
        }
        if (count(facts.elements, "data-movcues-survey-controls") !== 1)
            errors.push("Survey controls must remain exactly once.");
        if (count(facts.elements, "data-movcues-survey-action", "submit") !== 1)
            errors.push("Survey submission control must remain exactly once.");
    }
    if (options.checklist) {
        for (const role of ["root", "title", "items", "progress", "launcher-label", "remaining-count", "completion-title", "completion-description", "completion-acknowledge"])
            if (count(facts.elements, "data-movcues-checklist-role", role) !== 1)
                errors.push(`Checklist role ${role} must remain exactly once.`);
        for (const item of options.checklist.items)
            if (count(facts.elements, "data-movcues-checklist-item-id", item.id) !== 1)
                errors.push(`Checklist item ${item.id} must remain exactly once.`);
    }
    if (options.editable && root)
        errors.push(...sourceEditabilityErrors(sourceElement(root), options.previousHtml ? htmlFacts(options.previousHtml).roots.map(sourceElement)[0] : undefined, options.survey?.questions), ...sourceEditingCssErrors(input.css));
    return [...new Set(errors)];
}
function textContent(node) {
    if ("value" in node)
        return node.value;
    return "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
}
export function sourceContentProjection(html, fallback) {
    const { elements } = htmlFacts(html);
    const marked = (value) => elements.find(element => attribute(element, "data-movcues-content") === value);
    const heading = marked("heading"), body = marked("body");
    return { ...fallback, heading: heading ? textContent(heading).trim().slice(0, 500) : fallback.heading, body: body ? textContent(body).trim().slice(0, 10_000) : fallback.body };
}
export function applySourceMarkup(builder, source) {
    const previous = builder.projectData.movcues && typeof builder.projectData.movcues === "object" ? builder.projectData.movcues : {};
    builder.html = source.html;
    builder.css = source.css;
    builder.projectData = { ...builder.projectData, movcues: { ...previous, authoringSurface: "source", sourceVersion: 1, sourceEditabilityVersion: htmlFacts(source.html).roots[0] && !sourceEditabilityErrors(sourceElement(htmlFacts(source.html).roots[0])).length && !sourceEditingCssErrors(source.css).length ? SOURCE_EDITABILITY.version : undefined, actionBindings: structuredClone(source.actionBindings) } };
}
export function isSourceAuthored(builder) {
    const movcues = builder?.projectData.movcues;
    return Boolean(movcues && typeof movcues === "object" && movcues.authoringSurface === "source");
}
function sourceElement(element) {
    return { tag: element.tagName, attrs: Object.fromEntries(element.attrs.map(attr => [attr.name, attr.value])), text: element.childNodes.filter(node => "value" in node).map(node => "value" in node ? node.value : "").join(""), children: element.childNodes.filter((node) => "tagName" in node).map(sourceElement) };
}
//# sourceMappingURL=sourceMarkup.js.map