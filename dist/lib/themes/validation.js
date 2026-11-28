import { z } from "zod";
import { THEME_COMPONENTS, THEME_CONTROLS } from "./types.js";
const color = z.string().trim().min(1).max(40).regex(/^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s-]+\)|[a-z]{1,20})$/i);
const namedColors = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen`.split(" "));
function validPaint(value) {
    if (namedColors.has(value.toLowerCase()) || /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value))
        return true;
    const match = /^(rgb|hsl)a?\(([^)]+)\)$/i.exec(value);
    if (!match)
        return false;
    const comma = match[2].includes(",");
    const parts = comma ? match[2].split(",").map(part => part.trim()) : match[2].trim().split(/\s+/);
    if (!comma && parts[3] === "/")
        parts.splice(3, 1);
    if (parts.length < 3 || parts.length > 4 || !parts.every(part => /^-?(?:\d*\.)?\d+%?$/.test(part)))
        return false;
    return match[1].toLowerCase() === "rgb"
        ? !comma || parts.slice(0, 3).every(part => part.endsWith("%") === parts[0].endsWith("%"))
        : !parts[0].endsWith("%") && parts[1].endsWith("%") && parts[2].endsWith("%");
}
const designColor = color.refine(validPaint, "invalid color");
const designFamily = z.string().trim().regex(/^[\p{L}\p{N} _,'"-]{1,140}$/u);
const evidenceColor = z.string().max(40).regex(/^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([\d.,%\s-]+\))$/i);
const family = z.string().trim().min(1).max(200).refine(value => !/[{};@]|url\s*\(/i.test(value), "unsafe font family");
const evidenceFamily = z.string().regex(/^[\p{L}\p{N} _,'"-]{1,140}$/u);
const spacing = z.number().min(0).max(64);
const radius = z.number().min(0).max(100);
export const themeShadowSchema = z.object({ x: z.number().min(-100).max(100), y: z.number().min(-100).max(100), blur: z.number().min(0).max(200), spread: z.number().min(-100).max(100), color }).strict();
const colors = z.object({ background: color, surface: color, text: color, mutedText: color, primary: color, primaryForeground: color, border: color }).strict();
const designColors = z.object({ background: designColor, surface: designColor, text: designColor, mutedText: designColor, primary: designColor, primaryForeground: designColor, border: designColor }).strict();
const typography = z.object({
    bodyFontFamily: family, headingFontFamily: family,
    bodyFontSize: z.number().min(8).max(72), headingFontSize: z.number().min(10).max(160),
    bodyFontWeight: z.number().int().min(100).max(900), headingFontWeight: z.number().int().min(100).max(900),
    bodyLineHeight: z.number().min(.8).max(3), headingLineHeight: z.number().min(.8).max(3),
}).strict();
const designTypography = typography.extend({ bodyFontFamily: designFamily, headingFontFamily: designFamily });
const radii = z.object({ sm: radius, md: radius, lg: radius }).strict();
const shadows = z.object({ sm: themeShadowSchema, md: themeShadowSchema }).strict();
const designShadow = themeShadowSchema.extend({ color: designColor });
const designShadows = z.object({ sm: designShadow, md: designShadow }).strict();
const motion = z.enum(["system", "off"]);
export const componentStyleSchema = typography.pick({ bodyFontSize: true, headingFontSize: true, bodyLineHeight: true, headingLineHeight: true }).extend({
    spacing, radius, buttonRadius: radius, width: z.number().int().min(200).max(960), background: designColor, surface: designColor, text: designColor, shadow: designShadow,
}).partial().strict();
export const controlStyleSchema = z.object({
    radius, minHeight: z.number().min(0).max(72), background: designColor, foreground: designColor,
}).partial().strict();
const shared = z.partialRecord(z.enum(THEME_CONTROLS), controlStyleSchema);
const components = z.partialRecord(z.enum(THEME_COMPONENTS), componentStyleSchema);
export const foundationPatchSchema = z.object({
    colors: designColors.partial(), typography: designTypography.partial(), radii: radii.partial(), shadows: designShadows.partial(),
    spacing, focusColor: designColor, motion,
}).partial().strict();
export const designSystemSchema = z.object({
    version: z.literal(2), colors: designColors, typography: designTypography, radii, shadows: designShadows,
    spacing: spacing.optional(), width: z.number().int().min(200).max(960).optional(), focusColor: designColor.optional(), motion: motion.optional(), shared: shared.optional(), components: components.optional(),
}).strict();
const legacyTheme = z.object({
    version: z.literal(1), colors, typography, radii, shadows, spacing: spacing.optional(),
    components: z.partialRecord(z.enum(THEME_COMPONENTS), componentStyleSchema.pick({ spacing: true, radius: true, buttonRadius: true })).optional(),
}).strict();
export const siteThemeTokensSchema = z.discriminatedUnion("version", [legacyTheme, designSystemSchema]);
const roles = ["page", "navigation", "heading", "display", "dialog", "card", "primaryButton", "secondaryButton", "input", "label", "badge", "notification", "popover", "tooltip", "body"];
export const capturedDesignSchema = z.object({
    version: z.literal(2),
    samples: z.array(z.object({
        role: z.enum(roles), count: z.number().int().min(1).max(100),
        fontFamily: evidenceFamily.optional(), fontSize: z.number().min(0).max(200), fontWeight: z.number().min(0).max(900),
        lineHeight: z.number().min(0).max(4), letterSpacing: z.number().min(-10).max(20),
        color: evidenceColor.optional(), background: evidenceColor.optional(), backdrop: evidenceColor.optional(), borderColor: evidenceColor.optional(),
        borderWidth: z.number().min(0).max(24), radius, padding: z.number().min(0).max(80), gap: z.number().min(0).max(80),
        width: z.number().min(0).max(1600).optional(), height: z.number().min(0).max(1200).optional(),
        shadow: themeShadowSchema.extend({ color: evidenceColor }).optional(),
    }).strict()).min(1).max(45),
    variables: colors.extend({ background: evidenceColor, surface: evidenceColor, text: evidenceColor, mutedText: evidenceColor,
        primary: evidenceColor, primaryForeground: evidenceColor, border: evidenceColor }).partial().strict(),
    confidence: z.object({ typography: z.number().min(0).max(1), primary: z.number().min(0).max(1), surfaces: z.number().min(0).max(1) }).strict(),
    provenance: z.object({ typography: z.enum(["heading", "page"]), primary: z.enum(["variable", "button", "default"]), surfaces: z.enum(["component", "page"]) }).strict().optional(),
}).strict();
const safeEvidenceValue = z.string().max(300).refine(value => !/[{}]|javascript\s*:|expression\s*\(|url\s*\(/i.test(value));
export const themeCapturePayloadSchema = z.union([
    z.object({ evidence: capturedDesignSchema }).strict(),
    z.object({
        tokens: legacyTheme,
        evidence: z.object({
            confidence: z.record(z.string().max(100), z.number().min(0).max(1)).refine(value => Object.keys(value).length <= 50),
            cssVariables: z.record(z.string().regex(/^--[a-z0-9_-]{1,100}$/i), safeEvidenceValue).refine(value => Object.keys(value).length <= 100),
            sdkVersion: z.string().trim().min(1).max(40),
        }).strict(),
    }).strict(),
]);
//# sourceMappingURL=validation.js.map