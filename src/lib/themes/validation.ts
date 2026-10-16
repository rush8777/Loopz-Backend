import { z } from "zod";

const color = z.string().trim().min(1).max(40).regex(/^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s-]+\)|[a-z]{1,20})$/i);
const family = z.string().trim().min(1).max(200).refine(value => !/[{};@]|url\s*\(/i.test(value), "unsafe font family");
const shadow = z.object({ x: z.number().min(-100).max(100), y: z.number().min(-100).max(100), blur: z.number().min(0).max(200), spread: z.number().min(-100).max(100), color }).strict();

export const siteThemeTokensSchema = z.object({
  version: z.literal(1),
  colors: z.object({ background: color, surface: color, text: color, mutedText: color, primary: color, primaryForeground: color, border: color }).strict(),
  typography: z.object({
    bodyFontFamily: family, headingFontFamily: family,
    bodyFontSize: z.number().min(8).max(72), headingFontSize: z.number().min(10).max(160),
    bodyFontWeight: z.number().int().min(100).max(900), headingFontWeight: z.number().int().min(100).max(900),
    bodyLineHeight: z.number().min(0.8).max(3), headingLineHeight: z.number().min(0.8).max(3),
  }).strict(),
  radii: z.object({ sm: z.number().min(0).max(100), md: z.number().min(0).max(100), lg: z.number().min(0).max(100) }).strict(),
  shadows: z.object({ sm: shadow, md: shadow }).strict(),
}).strict();

const safeEvidenceValue = z.string().max(300).refine(value => !/[{}]|javascript\s*:|expression\s*\(|url\s*\(/i.test(value));
export const themeCapturePayloadSchema = z.object({
  tokens: siteThemeTokensSchema,
  evidence: z.object({
    confidence: z.record(z.string().max(100), z.number().min(0).max(1)).refine(value => Object.keys(value).length <= 50),
    cssVariables: z.record(z.string().regex(/^--[a-z0-9_-]{1,100}$/i), safeEvidenceValue).refine(value => Object.keys(value).length <= 100),
    sdkVersion: z.string().trim().min(1).max(40),
  }).strict(),
}).strict();
