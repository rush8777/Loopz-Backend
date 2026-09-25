/** Backend-authoritative builder security contract, mirrored by dashboard and SDK. */
export const BUILDER_ALLOWED_TAGS = new Set(["div", "section", "header", "h1", "h2", "h3", "h4", "p", "span", "br", "button", "img", "hr", "label", "ul", "li"]);
export const BUILDER_SURVEY_INPUT_TAGS = new Set(["input", "textarea"]);
export const BUILDER_ALLOWED_ATTRIBUTES = new Set(["class", "id", "title", "role", "aria-label", "aria-live", "aria-hidden", "aria-pressed", "alt", "src", "width", "height", "type", "placeholder", "maxlength", "data-movecues-action-id", "data-movecues-content", "data-movecues-widget-type", "data-movecues-question-id", "data-movecues-question-type", "data-movecues-question-input", "data-movecues-option-id", "data-movecues-survey-action", "data-movecues-survey-controls", "data-movecues-survey-progress", "data-movecues-survey-progress-bar", "data-movecues-survey-step-id", "data-movecues-checklist-role", "data-movecues-checklist-item-id", "data-movecues-checklist-item-role", "data-movecues-checklist-view"]);
export const BUILDER_UNSAFE_CSS = /@import|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding/i;
export function builderImageUrlIsSafe(value) { return !value || /^(https?:|data:image\/(?:png|gif|jpeg|webp);base64,|\/)/i.test(value); }
export function builderInputTypeIsSafe(value) { return ["text", "radio", "checkbox", "number"].includes(value.toLowerCase()); }
export function builderCssIsSafe(value) {
    const css = value.replace(/\/\*[\s\S]*?\*\//g, "");
    if (BUILDER_UNSAFE_CSS.test(css))
        return false;
    for (const match of css.matchAll(/([^{}]+)\{/g)) {
        const prelude = match[1].trim();
        if (!prelude || prelude.startsWith("@"))
            continue;
        if (prelude.split(",").some(selector => !selector.trim().includes(".movecues-widget")))
            return false;
    }
    return true;
}
export function builderHtmlIsSafe(value, allowSurveyInputs = false) {
    if (/<\s*(script|style|iframe|object|embed|form|select|video|audio|source)\b|\son[a-z]+\s*=|javascript\s*:/i.test(value))
        return false;
    for (const tagMatch of value.matchAll(/<\s*([a-z][\w-]*)\b([^>]*)>/gi)) {
        const tag = tagMatch[1].toLowerCase();
        if (!BUILDER_ALLOWED_TAGS.has(tag) && !(allowSurveyInputs && BUILDER_SURVEY_INPUT_TAGS.has(tag)))
            return false;
        let attributes = tagMatch[2].trim();
        while (attributes && attributes !== "/") {
            const attribute = /^([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?\s*/.exec(attributes);
            if (!attribute)
                return false;
            const name = attribute[1].toLowerCase();
            const attributeValue = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
            if (!BUILDER_ALLOWED_ATTRIBUTES.has(name))
                return false;
            if (name === "src" && (tag !== "img" || !builderImageUrlIsSafe(attributeValue)))
                return false;
            if (name === "data-movecues-action-id" && attributeValue !== "primary" && attributeValue !== "secondary")
                return false;
            if (name === "data-movecues-survey-action" && attributeValue !== "back" && attributeValue !== "next" && attributeValue !== "submit")
                return false;
            attributes = attributes.slice(attribute[0].length).trim();
        }
        if (tag === "input") {
            const type = /\btype\s*=\s*["']?([^\s"'>]+)/i.exec(tagMatch[2])?.[1] ?? "text";
            if (!builderInputTypeIsSafe(type))
                return false;
        }
    }
    return true;
}
//# sourceMappingURL=builderContentContract.js.map