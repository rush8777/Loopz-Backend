import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
/** Backend-authoritative builder security contract, mirrored by dashboard and SDK. */
export const BUILDER_ALLOWED_TAGS = new Set(["div", "section", "header", "h1", "h2", "h3", "h4", "p", "span", "br", "button", "img", "hr", "label", "strong", "em", "u", "a", "ul", "ol", "li"]);
export const BUILDER_SURVEY_INPUT_TAGS = new Set(["input", "textarea"]);
export const BUILDER_ALLOWED_ATTRIBUTES = new Set(["class", "id", "title", "role", "aria-label", "aria-live", "aria-hidden", "aria-pressed", "alt", "src", "href", "target", "rel", "width", "height", "type", "placeholder", "maxlength", "data-movcues-action-id", "data-movcues-content", "data-movcues-widget-type", "data-movcues-document-version", "data-movcues-node-id", "data-movcues-block-id", "data-movcues-sizing", "data-movcues-responsive-stack", "data-movcues-question-id", "data-movcues-question-type", "data-movcues-question-input", "data-movcues-option-id", "data-movcues-survey-action", "data-movcues-survey-controls", "data-movcues-survey-progress", "data-movcues-survey-progress-bar", "data-movcues-survey-step-id", "data-movcues-checklist-role", "data-movcues-checklist-item-id", "data-movcues-checklist-item-role", "data-movcues-checklist-view"]);
export const BUILDER_UNSAFE_CSS = /@import|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding/i;

export function builderImageUrlIsSafe(value: string): boolean { return !value || (!/[\u0000-\u0020\u007f]/.test(value) && /^(https?:\/\/|data:image\/(?:png|gif|jpeg|webp);base64,|\/)/i.test(value)); }
export function builderLinkUrlIsSafe(value: string): boolean { return !/[\u0000-\u001f\u007f]/.test(value) && /^(https?:\/\/|mailto:|tel:|\/|#|\?|\.\.?\/)/i.test(value.trim()); }
export function builderInputTypeIsSafe(value: string): boolean { return ["text", "radio", "checkbox", "number"].includes(value.toLowerCase()); }

export function builderCssIsSafe(value: string): boolean {
  const css = value.replace(/\/\*[\s\S]*?\*\//g, "");
  if (BUILDER_UNSAFE_CSS.test(css)) return false;
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1].trim();
    if (!prelude || prelude.startsWith("@")) continue;
    if (prelude.split(",").some(selector => !selector.trim().includes(".movcues-widget"))) return false;
  }
  return true;
}

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
export function builderHtmlIsSafe(value: string, allowSurveyInputs = false): boolean {
  let valid = true;
  const fragment = parseFragment(value, { sourceCodeLocationInfo: true, onParseError: () => { valid = false; } });
  const visit = (node: HtmlNode, ancestors: string[] = []): void => {
    if (!("tagName" in node)) { if ("childNodes" in node) node.childNodes.forEach(child => visit(child, ancestors)); return; }
    const tag = node.tagName;
    if (!BUILDER_ALLOWED_TAGS.has(tag) && !(allowSurveyInputs && BUILDER_SURVEY_INPUT_TAGS.has(tag))) { valid = false; return; }
    // Reject parser repairs and invalid nesting instead of persisting a different tree.
    if (!node.sourceCodeLocation || (!["img", "br", "hr", "input"].includes(tag) && !node.sourceCodeLocation.endTag)) valid = false;
    if (ancestors.includes("button") && !["span", "strong", "em", "u", "br"].includes(tag)) valid = false;
    if (tag === "a" && ancestors.includes("a")) valid = false;
    if (tag === "li" && !["ul", "ol"].includes(ancestors[ancestors.length - 1])) valid = false;
    if (["ul", "ol"].includes(tag) && ancestors.some(parent => ["p", "h1", "h2", "h3", "h4", "button"].includes(parent))) valid = false;
    const attrs = new Map(node.attrs.map(attr => [attr.name, attr.value]));
    for (const attr of node.attrs) {
      const name = attr.name; const attributeValue = attr.value;
      if (!BUILDER_ALLOWED_ATTRIBUTES.has(name) || attr.namespace || /^on/i.test(name)) valid = false;
      if (name === "src" && (tag !== "img" || !builderImageUrlIsSafe(attributeValue))) valid = false;
      if (name === "href" && (tag !== "a" || !builderLinkUrlIsSafe(attributeValue))) valid = false;
      if (name === "target" && (tag !== "a" || !["_blank", "_self"].includes(attributeValue))) valid = false;
      if (name === "rel" && (tag !== "a" || !/^(?:noopener|noreferrer|nofollow|\s)+$/i.test(attributeValue))) valid = false;
      if (name === "data-movcues-action-id" && !["primary", "secondary"].includes(attributeValue) && !/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(attributeValue)) valid = false;
      if (name === "data-movcues-survey-action" && !["back", "next", "submit"].includes(attributeValue)) valid = false;
    }
    if (tag === "a" && attrs.get("target") === "_blank" && !["noopener", "noreferrer"].every(token => attrs.get("rel")?.split(/\s+/).includes(token))) valid = false;
    if (tag === "input" && !builderInputTypeIsSafe(attrs.get("type") ?? "text")) valid = false;
    node.childNodes.forEach(child => visit(child, [...ancestors, tag]));
  };
  visit(fragment); return valid;
}

function projection(parent: HtmlNode): string {
  let result = "";
  if (!("childNodes" in parent)) return "value" in parent ? parent.value : "";
  for (const child of parent.childNodes) {
    if ("value" in child) { result += child.value; continue; }
    if ("tagName" in child && child.tagName === "br") { result += "\n"; continue; }
    const block = "tagName" in child && ["li", "p", "div", "ul", "ol"].includes(child.tagName);
    if (block && result && !result.endsWith("\n")) result += "\n";
    result += projection(child);
    if (block && !result.endsWith("\n")) result += "\n";
  }
  return result;
}
/** Validate HTML/plain-text agreement only for the dedicated on-site surface. */
export function onsiteProjectionIsConsistent(html: string, content: { heading: string; body: string; primaryAction?: { label: string }; secondaryAction?: { label: string } }): boolean {
  const components = new Map<string, HtmlElement>(); let valid = true;
  const visit = (node: HtmlNode) => {
    if ("tagName" in node) {
      const marker = node.attrs.find(attr => ["data-movcues-content", "data-movcues-action-id"].includes(attr.name))?.value;
      if (marker) { if (components.has(marker)) valid = false; components.set(marker, node); }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }; visit(parseFragment(html));
  for (const [key, expected] of [["heading", content.heading], ["body", content.body], ["primary", content.primaryAction?.label], ["secondary", content.secondaryAction?.label]] as const) {
    const component = components.get(key);
    if (expected === undefined) { if (component) valid = false; }
    else if (!component || projection(component).trim() !== expected) valid = false;
  }
  return valid;
}
