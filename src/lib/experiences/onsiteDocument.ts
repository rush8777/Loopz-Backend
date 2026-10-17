import type { ExperienceAction, ExperienceContent, WidgetBuilderState, WidgetType } from "./types.js";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { builderImageUrlIsSafe, builderLinkUrlIsSafe } from "./builderContentContract.js";

export const ONSITE_SCHEMA_VERSION = 2 as const;
export const ONSITE_LIMITS = {
  maxDepth: 8,
  maxNodes: 120,
  maxRichText: 10_000,
  maxImageUrl: 2_000,
  maxSerializedBytes: 250_000,
  minFixedSize: 24,
  maxFixedSize: 1_200,
} as const;

export type OnsiteDirection = "row" | "column";
export type OnsiteSizing =
  | { mode: "flexible"; weight: number }
  | { mode: "hug" }
  | { mode: "fixed"; value: number };
export interface OnsiteSpacing { top: number; right: number; bottom: number; left: number }
export interface OnsiteCellStyle { background?: string; borderColor?: string; borderWidth?: number; borderRadius?: number }
export interface OnsiteCell {
  type: "cell";
  id: string;
  direction: OnsiteDirection;
  sizing: OnsiteSizing;
  align: "start" | "center" | "end" | "stretch";
  justify: "start" | "center" | "end" | "space-between";
  gap: number;
  padding: OnsiteSpacing;
  responsiveStack?: boolean;
  style?: OnsiteCellStyle;
  children?: OnsiteCell[];
  block?: OnsiteBlock;
}

interface BlockBase { id: string; align?: "left" | "center" | "right" }
export type OnsiteButtonAction =
  | { id: string; type: "next_step" | "previous_step" | "dismiss" }
  | { id: string; type: "open_url"; url: string }
  | { id: string; type: "track_event"; eventName: string };
export type OnsiteBlock =
  | (BlockBase & { type: "heading"; html: string; level: 1 | 2 | 3 | 4; fontSize: number; weight: 400 | 500 | 600 | 700; color?: string; lineHeight?: number })
  | (BlockBase & { type: "text"; html: string; fontSize: number; weight: 400 | 500 | 600 | 700; color?: string; lineHeight?: number })
  | (BlockBase & { type: "button"; label: string; action: OnsiteButtonAction; variant: "primary" | "secondary" | "outline"; background?: string; color?: string; radius: number; paddingX: number; paddingY: number; width: "hug" | "full" })
  | (BlockBase & { type: "image"; src: string; alt: string; fit: "contain" | "cover"; width: number; height?: number; radius: number })
  | (BlockBase & { type: "divider"; orientation: "horizontal" | "vertical"; thickness: number; color: string })
  | (BlockBase & { type: "spacer"; size: number })
  | (BlockBase & { type: "icon"; icon: OnsiteIcon; size: number; color?: string });
export type OnsiteIcon = "check" | "star" | "info" | "warning" | "sparkles" | "arrow" | "heart" | "rocket";
export interface OnsiteDocument { schemaVersion: 2; id: string; root: OnsiteCell }
export interface CompiledOnsiteDocument { html: string; css: string; content: ExperienceContent; actionBindings: Record<string, OnsiteButtonAction> }
export interface OnsiteValidationResult { valid: boolean; errors: string[] }

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s-]+\)|[a-z]{1,20})$/i;
const SAFE_INLINE_TAGS = new Set(["BR", "STRONG", "EM", "U", "A", "UL", "OL", "LI"]);
const ICONS: Record<OnsiteIcon, string> = { check: "✓", star: "★", info: "ℹ", warning: "⚠", sparkles: "✦", arrow: "→", heart: "♥", rocket: "🚀" };

let idSequence = 0;
export function onsiteId(prefix: "document" | "cell" | "block" | "action" = "cell"): string {
  idSequence = (idSequence + 1) % 0xffff;
  const random = typeof crypto !== "undefined" && "getRandomValues" in crypto
    ? Array.from(crypto.getRandomValues(new Uint32Array(2))).map(value => value.toString(36)).join("")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}${idSequence.toString(36)}`.slice(0, 64);
}

export function emptyCell(block?: OnsiteBlock): OnsiteCell {
  return { type: "cell", id: onsiteId("cell"), direction: "column", sizing: { mode: "flexible", weight: 1 }, align: "stretch", justify: "start", gap: 12, padding: { top: 0, right: 0, bottom: 0, left: 0 }, ...(block ? { block } : {}) };
}

export function createBlock(type: OnsiteBlock["type"], guide = false): OnsiteBlock {
  const id = onsiteId("block");
  if (type === "heading") return { id, type, html: "A clear heading", level: 2, fontSize: 24, weight: 600, lineHeight: 1.25 };
  if (type === "text") return { id, type, html: "Add supporting text for your visitors.", fontSize: 15, weight: 400, lineHeight: 1.5 };
  if (type === "button") return { id, type, label: guide ? "Next" : "Got it", action: { id: onsiteId("action"), type: guide ? "next_step" : "dismiss" }, variant: "primary", radius: 8, paddingX: 16, paddingY: 9, width: "hug", align: "right" };
  if (type === "image") return { id, type, src: "", alt: "", fit: "cover", width: 100, radius: 8, align: "center" };
  if (type === "divider") return { id, type, orientation: "horizontal", thickness: 1, color: "#dbe2ea" };
  if (type === "spacer") return { id, type, size: 24 };
  return { id, type: "icon", icon: "sparkles", size: 28, color: "#2563eb", align: "center" };
}

export function createOnsiteDocument(guide = false): OnsiteDocument {
  const heading = emptyCell(createBlock("heading", guide));
  const text = emptyCell(createBlock("text", guide));
  const button = emptyCell(createBlock("button", guide));
  return { schemaVersion: 2, id: onsiteId("document"), root: { ...emptyCell(), direction: "column", gap: 12, padding: { top: 20, right: 20, bottom: 20, left: 20 }, children: [heading, text, button] } };
}

export function onsiteDocumentFromBuilder(builder?: WidgetBuilderState): OnsiteDocument | null {
  const movcues = builder?.projectData?.movcues;
  if (!movcues || typeof movcues !== "object") return null;
  const document = (movcues as Record<string, unknown>).onsiteDocument;
  return isOnsiteDocument(document) ? document : null;
}

export function applyOnsiteDocument(builder: WidgetBuilderState, document: OnsiteDocument, widgetType: WidgetType | "anchored_card" | "modal"): CompiledOnsiteDocument {
  const compiled = compileOnsiteDocument(document, widgetType);
  builder.version = 1;
  builder.projectData = { ...builder.projectData, movcues: { ...asRecord(builder.projectData.movcues), authoringSurface: "onsite", schemaVersion: 2, onsiteDocument: document, actionBindings: compiled.actionBindings } };
  builder.html = compiled.html;
  builder.css = compiled.css;
  return compiled;
}

export function rawOnsiteDocument(builder?: WidgetBuilderState): unknown {
  const movcues = builder?.projectData?.movcues;
  return movcues && typeof movcues === "object" ? (movcues as Record<string, unknown>).onsiteDocument : undefined;
}

export function validateCompiledOnsiteBuilder(builder: WidgetBuilderState, content: ExperienceContent, widgetType: WidgetType | "anchored_card" | "modal", guide: boolean): string[] {
  const raw = rawOnsiteDocument(builder); if (raw === undefined) return [];
  const result = validateOnsiteDocument(raw); if (!result.valid) return result.errors;
  const document = raw as OnsiteDocument; const compiled = compileOnsiteDocument(document, widgetType); const errors: string[] = [];
  if (builder.html !== compiled.html) errors.push("Compiled on-site HTML does not match the structured document.");
  if (builder.css !== compiled.css) errors.push("Compiled on-site CSS does not match the structured document.");
  const movcues = builder.projectData.movcues as Record<string, unknown>;
  if (JSON.stringify(movcues.actionBindings) !== JSON.stringify(compiled.actionBindings)) errors.push("Compiled on-site action binding map does not match the structured document.");
  if (JSON.stringify(content) !== JSON.stringify(compiled.content)) errors.push("Structured content does not match the compiled on-site document projection.");
  for (const block of listBlocks(document.root)) if (block.type === "button" && !guide && (block.action.type === "next_step" || block.action.type === "previous_step")) errors.push(`${block.action.type} is only supported by Guides.`);
  return errors;
}

export function compileOnsiteDocument(document: OnsiteDocument, widgetType: string): CompiledOnsiteDocument {
  const validation = validateOnsiteDocument(document);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  const css: string[] = [
    ".movcues-widget{box-sizing:border-box;width:100%;max-width:100%;min-width:0;overflow-wrap:anywhere;background:var(--movcues-bg);color:var(--movcues-fg)}",
    ".movcues-widget *{box-sizing:border-box}",
    ".movcues-widget .movcues-cell{display:flex;min-width:0;max-width:100%}",
    ".movcues-widget .movcues-block{min-width:0;max-width:100%;margin:0}",
    ".movcues-widget .movcues-block img{display:block;max-width:100%}",
    ".movcues-widget .movcues-button{border:0;font:600 14px/1.2 ui-sans-serif,system-ui,sans-serif;cursor:pointer}",
    ".movcues-widget .movcues-button--primary{background:var(--movcues-primary);color:#fff}",
    ".movcues-widget .movcues-button--secondary{background:transparent;color:inherit}",
    ".movcues-widget .movcues-button--outline{background:transparent;color:inherit;border:1px solid currentColor}",
    ".movcues-widget .movcues-block--full{width:100%}",
  ];
  const html = renderCell(document.root, css, 0);
  css.push("@media(max-width:480px){.movcues-widget [data-movcues-responsive-stack=\"true\"]{flex-direction:column!important}.movcues-widget [data-movcues-sizing=\"fixed\"]{max-width:100%!important}.movcues-widget .movcues-button{min-height:40px}.movcues-widget img{height:auto!important}}");
  const blocks = listBlocks(document.root);
  const firstHeading = blocks.find(block => block.type === "heading") as Extract<OnsiteBlock, { type: "heading" }> | undefined;
  const text = blocks.filter(block => block.type === "text").map(block => richTextToPlain((block as Extract<OnsiteBlock, { type: "text" }>).html)).join("\n").slice(0, 2_000);
  const actions = blocks.filter(block => block.type === "button") as Array<Extract<OnsiteBlock, { type: "button" }>>;
  const actionBindings = Object.fromEntries(actions.map(block => [block.action.id, block.action]));
  const legacy = actions.slice(0, 2).map(block => ({ label: block.label, type: block.action.type === "previous_step" ? "dismiss" as const : block.action.type, ...("url" in block.action ? { url: block.action.url } : {}), ...("eventName" in block.action ? { eventName: block.action.eventName } : {}) }));
  const content: ExperienceContent = {
    heading: firstHeading ? richTextToPlain(firstHeading.html).slice(0, 160) : "",
    body: text,
    ...(legacy[0] ? { primaryAction: legacy[0] as ExperienceAction } : {}),
    ...(legacy[1]?.type === "dismiss" ? { secondaryAction: { label: legacy[1].label, type: "dismiss" as const } } : {}),
  };
  return { html: `<section class="movcues-widget movcues-widget--${escapeAttribute(widgetType)}" data-movcues-widget-type="${escapeAttribute(widgetType)}" data-movcues-document-version="2">${html}</section>`, css: css.join(""), content, actionBindings };
}

function renderCell(cell: OnsiteCell, css: string[], depth: number): string {
  const selector = `.movcues-widget [data-movcues-node-id="${cell.id}"]`;
  const sizing = cell.sizing.mode === "flexible" ? `flex:${round(cell.sizing.weight)} 1 0` : cell.sizing.mode === "hug" ? "flex:0 0 auto" : `flex:0 1 ${cell.sizing.value}px`;
  const style = cell.style ?? {};
  css.push(`${selector}{${sizing};flex-direction:${cell.direction};align-items:${cell.align};justify-content:${cell.justify};gap:${cell.gap}px;padding:${cell.padding.top}px ${cell.padding.right}px ${cell.padding.bottom}px ${cell.padding.left}px;${style.background ? `background:${style.background};` : ""}${style.borderWidth ? `border:${style.borderWidth}px solid ${style.borderColor ?? "#dbe2ea"};` : ""}${style.borderRadius ? `border-radius:${style.borderRadius}px;` : ""}}`);
  const children = cell.children?.map(child => renderCell(child, css, depth + 1)).join("") ?? (cell.block ? renderBlock(cell.block, css) : "");
  return `<div class="movcues-cell" data-movcues-node-id="${cell.id}" data-movcues-sizing="${cell.sizing.mode}"${cell.responsiveStack ? ' data-movcues-responsive-stack="true"' : ""}>${children}</div>`;
}

function renderBlock(block: OnsiteBlock, css: string[]): string {
  const selector = `.movcues-widget [data-movcues-block-id="${block.id}"]`;
  const align = block.align ?? "left";
  if (block.type === "heading") { css.push(`${selector}{font:${block.weight} ${block.fontSize}px/${block.lineHeight ?? 1.25} ui-sans-serif,system-ui,sans-serif;text-align:${align};${block.color ? `color:${block.color};` : ""}}`); return `<h${block.level} class="movcues-block movcues-heading" data-movcues-block-id="${block.id}" data-movcues-content="heading">${sanitizeRichText(block.html)}</h${block.level}>`; }
  if (block.type === "text") { css.push(`${selector}{font:${block.weight} ${block.fontSize}px/${block.lineHeight ?? 1.5} ui-sans-serif,system-ui,sans-serif;text-align:${align};white-space:pre-wrap;${block.color ? `color:${block.color};` : ""}}`); return `<div class="movcues-block movcues-text" data-movcues-block-id="${block.id}" data-movcues-content="body">${sanitizeRichText(block.html)}</div>`; }
  if (block.type === "button") { css.push(`${selector}{align-self:${align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center"};padding:${block.paddingY}px ${block.paddingX}px;border-radius:${block.radius}px;${block.width === "full" ? "width:100%;" : ""}${block.background ? `background:${block.background};` : ""}${block.color ? `color:${block.color};` : ""}}`); return `<button type="button" class="movcues-block movcues-button movcues-button--${block.variant}${block.width === "full" ? " movcues-block--full" : ""}" data-movcues-block-id="${block.id}" data-movcues-action-id="${block.action.id}">${escapeText(block.label)}</button>`; }
  if (block.type === "image") { css.push(`${selector}{align-self:${align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center"};width:${block.width}%;${block.height ? `height:${block.height}px;` : "height:auto;"}object-fit:${block.fit};border-radius:${block.radius}px}`); return `<img class="movcues-block movcues-image" data-movcues-block-id="${block.id}" src="${escapeAttribute(block.src)}" alt="${escapeAttribute(block.alt)}">`; }
  if (block.type === "divider") { css.push(`${selector}{align-self:stretch;${block.orientation === "horizontal" ? `width:100%;height:${block.thickness}px` : `width:${block.thickness}px;min-height:24px`};border:0;background:${block.color}}`); return `<hr class="movcues-block movcues-divider" data-movcues-block-id="${block.id}">`; }
  if (block.type === "spacer") { css.push(`${selector}{flex:0 0 ${block.size}px;width:${block.size}px;height:${block.size}px}`); return `<div class="movcues-block movcues-spacer" data-movcues-block-id="${block.id}" aria-hidden="true"></div>`; }
  css.push(`${selector}{align-self:${align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center"};font-size:${block.size}px;line-height:1;${block.color ? `color:${block.color};` : ""}}`); return `<span class="movcues-block movcues-icon" data-movcues-block-id="${block.id}" role="img" aria-label="${block.icon}">${ICONS[block.icon]}</span>`;
}

export function validateOnsiteDocument(value: unknown): OnsiteValidationResult {
  const errors: string[] = [];
  if (!isOnsiteDocumentShape(value)) return { valid: false, errors: ["On-site document must use schemaVersion 2 and contain one root cell."] };
  unexpectedKeys(value as unknown as Record<string, unknown>, ["schemaVersion", "id", "root"], "Document", errors);
  const ids = new Set<string>(); const seen = new Set<object>(); let count = 0;
  const addId = (id: unknown, path: string) => { if (typeof id !== "string" || !ID_PATTERN.test(id)) errors.push(`${path} has an invalid ID.`); else if (ids.has(id)) errors.push(`${path} reuses ID ${id}.`); else ids.add(id); };
  const number = (input: unknown, min: number, max: number, path: string) => { if (typeof input !== "number" || !Number.isFinite(input) || input < min || input > max) errors.push(`${path} must be between ${min} and ${max}.`); };
  addId(value.id, "Document");
  const visit = (cell: OnsiteCell, depth: number, path: string): void => {
    if (!cell || typeof cell !== "object") { errors.push(`${path} must be a cell object.`); return; } if (seen.has(cell)) { errors.push(`${path} creates a cycle or duplicate reference.`); return; } seen.add(cell);
    count++; addId(cell.id, path);
    unexpectedKeys(cell as unknown as Record<string, unknown>, ["type", "id", "direction", "sizing", "align", "justify", "gap", "padding", "responsiveStack", "style", "children", "block"], path, errors);
    if (depth > ONSITE_LIMITS.maxDepth) errors.push(`${path} exceeds maximum nesting depth ${ONSITE_LIMITS.maxDepth}.`);
    if (!(["row", "column"] as unknown[]).includes(cell.direction)) errors.push(`${path} has an invalid direction.`);
    if (!["start", "center", "end", "stretch"].includes(cell.align)) errors.push(`${path} has an invalid alignment.`);
    if (!["start", "center", "end", "space-between"].includes(cell.justify)) errors.push(`${path} has an invalid distribution.`);
    if (cell.responsiveStack !== undefined && typeof cell.responsiveStack !== "boolean") errors.push(`${path} responsiveStack must be a boolean.`);
    number(cell.gap, 0, 96, `${path} gap`);
    for (const side of ["top", "right", "bottom", "left"] as const) number(cell.padding?.[side], 0, 128, `${path} padding ${side}`);
    if (cell.sizing?.mode === "flexible") number(cell.sizing.weight, 0.1, 20, `${path} flexible weight`);
    else if (cell.sizing?.mode === "fixed") number(cell.sizing.value, ONSITE_LIMITS.minFixedSize, ONSITE_LIMITS.maxFixedSize, `${path} fixed size`);
    else if (cell.sizing?.mode !== "hug") errors.push(`${path} has an invalid sizing mode.`);
    if (cell.sizing && typeof cell.sizing === "object") unexpectedKeys(cell.sizing as unknown as Record<string, unknown>, cell.sizing.mode === "flexible" ? ["mode", "weight"] : cell.sizing.mode === "fixed" ? ["mode", "value"] : ["mode"], `${path} sizing`, errors);
    if (cell.style) { unexpectedKeys(cell.style as unknown as Record<string, unknown>, ["background", "borderColor", "borderWidth", "borderRadius"], `${path} style`, errors); if (cell.style.background && !COLOR_PATTERN.test(cell.style.background)) errors.push(`${path} background is not supported.`); if (cell.style.borderColor && !COLOR_PATTERN.test(cell.style.borderColor)) errors.push(`${path} border color is not supported.`); if (cell.style.borderWidth !== undefined) number(cell.style.borderWidth, 0, 16, `${path} border width`); if (cell.style.borderRadius !== undefined) number(cell.style.borderRadius, 0, 100, `${path} border radius`); }
    if (cell.children && cell.block) errors.push(`${path} cannot contain both children and a block.`);
    if (cell.children) { if (!cell.children.length) errors.push(`${path} cannot contain an empty children list.`); cell.children.forEach((child, index) => visit(child, depth + 1, `${path} > cell ${index + 1}`)); }
    if (cell.block) validateBlock(cell.block, `${path} block`, addId, number, errors);
  };
  try { visit(value.root, 1, "Root cell"); } catch { errors.push("Document contains malformed cell or block values."); }
  if (count > ONSITE_LIMITS.maxNodes) errors.push(`Document has ${count} cells; maximum is ${ONSITE_LIMITS.maxNodes}.`);
  try { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > ONSITE_LIMITS.maxSerializedBytes) errors.push(`Document exceeds ${ONSITE_LIMITS.maxSerializedBytes} serialized bytes.`); } catch { errors.push("Document cannot be serialized."); }
  return { valid: errors.length === 0, errors };
}

function validateBlock(block: OnsiteBlock, path: string, addId: (id: unknown, path: string) => void, number: (value: unknown, min: number, max: number, path: string) => void, errors: string[]): void {
  addId(block.id, path);
  const base = ["id", "type", "align"]; const keys: Record<OnsiteBlock["type"], string[]> = { heading: [...base, "html", "level", "fontSize", "weight", "color", "lineHeight"], text: [...base, "html", "fontSize", "weight", "color", "lineHeight"], button: [...base, "label", "action", "variant", "background", "color", "radius", "paddingX", "paddingY", "width"], image: [...base, "src", "alt", "fit", "width", "height", "radius"], divider: [...base, "orientation", "thickness", "color"], spacer: [...base, "size"], icon: [...base, "icon", "size", "color"] };
  if (!Object.prototype.hasOwnProperty.call(keys, block.type)) { errors.push(`${path} has an unsupported block type.`); return; }
  unexpectedKeys(block as unknown as Record<string, unknown>, keys[block.type], path, errors);
  if (block.align !== undefined && !["left", "center", "right"].includes(block.align)) errors.push(`${path} has an invalid alignment.`);
  if (block.type === "heading" || block.type === "text") {
    if (typeof block.html !== "string" || block.html.length > ONSITE_LIMITS.maxRichText || sanitizeRichText(block.html) !== block.html) errors.push(`${path} contains unsupported or unsafe rich text.`);
    number(block.fontSize, 10, 72, `${path} font size`); number(block.lineHeight ?? 1.4, 0.9, 3, `${path} line height`);
    if (![400, 500, 600, 700].includes(block.weight)) errors.push(`${path} has an invalid font weight.`); if (block.type === "heading" && ![1, 2, 3, 4].includes(block.level)) errors.push(`${path} has an invalid heading level.`);
  } else if (block.type === "button") {
    if (!block.label?.trim() || block.label.length > 80) errors.push(`${path} label must contain 1–80 characters.`);
    addId(block.action?.id, `${path} action`);
    if (!block.action || !["next_step", "previous_step", "dismiss", "open_url", "track_event"].includes(block.action.type)) errors.push(`${path} has an invalid action.`);
    else unexpectedKeys(block.action as unknown as Record<string, unknown>, block.action.type === "open_url" ? ["id", "type", "url"] : block.action.type === "track_event" ? ["id", "type", "eventName"] : ["id", "type"], `${path} action`, errors);
    if (block.action?.type === "open_url" && (!builderLinkUrlIsSafe(block.action.url) || !/^https?:\/\//i.test(block.action.url))) errors.push(`${path} URL must use HTTP(S).`);
    if (block.action?.type === "track_event" && (!block.action.eventName?.trim() || block.action.eventName.length > 200)) errors.push(`${path} custom event must contain 1–200 characters.`);
    if (!["primary", "secondary", "outline"].includes(block.variant)) errors.push(`${path} has an invalid variant.`); if (!["hug", "full"].includes(block.width)) errors.push(`${path} has an invalid width behavior.`); number(block.radius, 0, 48, `${path} radius`); number(block.paddingX, 4, 48, `${path} horizontal padding`); number(block.paddingY, 4, 32, `${path} vertical padding`);
  } else if (block.type === "image") {
    if (block.src.length > ONSITE_LIMITS.maxImageUrl || !builderImageUrlIsSafe(block.src)) errors.push(`${path} image URL is not allowed.`);
    if (block.alt.length > 500) errors.push(`${path} alt text exceeds 500 characters.`);
    if (!["contain", "cover"].includes(block.fit)) errors.push(`${path} has an invalid image fit.`); number(block.width, 1, 100, `${path} width`); if (block.height !== undefined) number(block.height, 24, 1_200, `${path} height`); number(block.radius, 0, 100, `${path} radius`);
  } else if (block.type === "divider") { if (!["horizontal", "vertical"].includes(block.orientation)) errors.push(`${path} has an invalid divider orientation.`); number(block.thickness, 1, 16, `${path} thickness`); }
  else if (block.type === "spacer") number(block.size, 4, 240, `${path} size`);
  else if (block.type === "icon") { if (!(block.icon in ICONS)) errors.push(`${path} icon is not supported.`); number(block.size, 12, 96, `${path} size`); }
  if ("color" in block && block.color && !COLOR_PATTERN.test(block.color)) errors.push(`${path} color is not supported.`);
}

function unexpectedKeys(value: Record<string, unknown>, allowed: string[], path: string, errors: string[]): void { const extra = Object.keys(value).filter(key => !allowed.includes(key)); if (extra.length) errors.push(`${path} contains unsupported fields: ${extra.join(", ")}.`); }

export function findCell(document: OnsiteDocument, id: string): OnsiteCell | null { let found: OnsiteCell | null = null; walkCells(document.root, cell => { if (cell.id === id) found = cell; }); return found; }
export function findBlock(document: OnsiteDocument, id: string): OnsiteBlock | null { let found: OnsiteBlock | null = null; walkCells(document.root, cell => { if (cell.block?.id === id) found = cell.block; }); return found; }
export function parentCell(document: OnsiteDocument, id: string): OnsiteCell | null { let found: OnsiteCell | null = null; walkCells(document.root, cell => { if (cell.children?.some(child => child.id === id)) found = cell; }); return found; }
export function cellForBlock(document: OnsiteDocument, id: string): OnsiteCell | null { let found: OnsiteCell | null = null; walkCells(document.root, cell => { if (cell.block?.id === id) found = cell; }); return found; }
export function listBlocks(cell: OnsiteCell): OnsiteBlock[] { const blocks: OnsiteBlock[] = []; walkCells(cell, item => { if (item.block) blocks.push(item.block); }); return blocks; }
function walkCells(cell: OnsiteCell, visit: (cell: OnsiteCell) => void): void { visit(cell); cell.children?.forEach(child => walkCells(child, visit)); }

export function splitCell(document: OnsiteDocument, cellId: string, direction: OnsiteDirection): string | null {
  const cell = findCell(document, cellId); if (!cell || cell.children) return null;
  const preserved = emptyCell(cell.block); const added = emptyCell(); delete cell.block; cell.children = [preserved, added]; cell.direction = direction; cell.responsiveStack = direction === "row";
  return added.id;
}
export function insertEdgeCell(document: OnsiteDocument, edge: "top" | "right" | "bottom" | "left"): string {
  const wanted: OnsiteDirection = edge === "left" || edge === "right" ? "row" : "column"; const added = emptyCell();
  if (document.root.children && document.root.direction === wanted && !document.root.block) document.root.children[edge === "top" || edge === "left" ? "unshift" : "push"](added);
  else { const old = structuredCloneSafe(document.root); old.id = onsiteId("cell"); document.root = { ...emptyCell(), id: document.root.id, direction: wanted, responsiveStack: wanted === "row", children: edge === "top" || edge === "left" ? [added, old] : [old, added] }; }
  return added.id;
}
export function removeCell(document: OnsiteDocument, id: string): boolean {
  const parent = parentCell(document, id); if (!parent?.children || parent.children.length <= 1) { const cell = findCell(document, id); if (!cell || cell === document.root) return false; delete cell.block; return true; }
  parent.children = parent.children.filter(child => child.id !== id); if (parent.children.length === 1) collapseSingleChild(parent); return true;
}
export function moveCell(document: OnsiteDocument, id: string, delta: -1 | 1): boolean { const parent = parentCell(document, id); if (!parent?.children) return false; const index = parent.children.findIndex(child => child.id === id); const next = index + delta; if (index < 0 || next < 0 || next >= parent.children.length) return false; [parent.children[index], parent.children[next]] = [parent.children[next], parent.children[index]]; return true; }
export function resizeSiblings(document: OnsiteDocument, firstId: string, secondId: string, firstWeight: number): boolean { const parent = parentCell(document, firstId); if (!parent?.children || parent !== parentCell(document, secondId)) return false; const a = parent.children.find(child => child.id === firstId); const b = parent.children.find(child => child.id === secondId); if (!a || !b) return false; const bounded = Math.max(0.1, Math.min(1.9, Math.round(firstWeight * 20) / 20)); a.sizing = { mode: "flexible", weight: bounded }; b.sizing = { mode: "flexible", weight: 2 - bounded }; return true; }
export function duplicateCell(document: OnsiteDocument, id: string): string | null { const source = findCell(document, id); const parent = parentCell(document, id); if (!source || !parent?.children) return null; const copy = structuredCloneSafe(source); regenerateIds(copy); const index = parent.children.findIndex(child => child.id === id); parent.children.splice(index + 1, 0, copy); return copy.id; }
function regenerateIds(cell: OnsiteCell): void { cell.id = onsiteId("cell"); if (cell.block) { cell.block.id = onsiteId("block"); if (cell.block.type === "button") cell.block.action.id = onsiteId("action"); } cell.children?.forEach(regenerateIds); }
function collapseSingleChild(cell: OnsiteCell): void { const child = cell.children?.[0]; if (!child) return; const id = cell.id; Object.assign(cell, child, { id }); }

export function duplicateDocument(document: OnsiteDocument): OnsiteDocument { const copy = structuredCloneSafe(document); copy.id = onsiteId("document"); regenerateIds(copy.root); return copy; }
export function cloneOnsite<T>(value: T): T { return structuredCloneSafe(value); }
function structuredCloneSafe<T>(value: T): T { return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T; }

export function sanitizeRichText(input: string): string { return richTextIsSafe(input) ? input : ""; }
function richTextIsSafe(input: string): boolean {
  let valid = true;
  const fragment = parseFragment(input, { sourceCodeLocationInfo: true, onParseError: () => { valid = false; } });
  const visit = (node: DefaultTreeAdapterMap["node"], ancestors: string[] = []): void => {
    if (!("tagName" in node)) { if ("childNodes" in node) node.childNodes.forEach(child => visit(child, ancestors)); return; }
    const tag = node.tagName.toUpperCase(); if (!SAFE_INLINE_TAGS.has(tag)) { valid = false; return; }
    if (tag === "A" && ancestors.includes("A")) valid = false;
    for (const attr of node.attrs) {
      if (tag !== "A" || !["href", "target", "rel"].includes(attr.name) || /^on/i.test(attr.name)) valid = false;
      if (attr.name === "href" && !builderLinkUrlIsSafe(attr.value)) valid = false;
      if (attr.name === "target" && !["_blank", "_self"].includes(attr.value)) valid = false;
      if (attr.name === "rel" && !/^(?:noopener|noreferrer|nofollow|\s)+$/i.test(attr.value)) valid = false;
    }
    const attrs = new Map(node.attrs.map(attr => [attr.name, attr.value]));
    if (tag === "A" && attrs.get("target") === "_blank" && !["noopener", "noreferrer"].every(token => attrs.get("rel")?.split(/\s+/).includes(token))) valid = false;
    node.childNodes.forEach(child => visit(child, [...ancestors, tag]));
  };
  visit(fragment); return valid;
}
function richTextToPlain(input: string): string {
  const fragment = parseFragment(input);
  const read = (node: DefaultTreeAdapterMap["node"]): string => {
    if ("value" in node) return node.value;
    if (!("childNodes" in node)) return "";
    let value = "";
    for (const child of node.childNodes) { if ("tagName" in child && child.tagName === "br") value += "\n"; else { value += read(child); if ("tagName" in child && child.tagName === "li") value += "\n"; } }
    return value;
  };
  return read(fragment).trim();
}
function isOnsiteDocument(value: unknown): value is OnsiteDocument { return isOnsiteDocumentShape(value) && validateOnsiteDocument(value).valid; }
function isOnsiteDocumentShape(value: unknown): value is OnsiteDocument { return !!value && typeof value === "object" && (value as OnsiteDocument).schemaVersion === 2 && !!(value as OnsiteDocument).root && (value as OnsiteDocument).root.type === "cell"; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function escapeText(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escapeAttribute(value: string): string { return escapeText(value).replace(/"/g, "&quot;"); }
function round(value: number): string { return String(Math.round(value * 100) / 100); }
