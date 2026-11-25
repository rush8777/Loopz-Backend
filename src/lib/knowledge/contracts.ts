import { z } from "zod";

export const sourceTypes = ["website", "url", "file", "manual"] as const;
export type SourceType = typeof sourceTypes[number];

const publicReference = z.string().trim().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Enter an HTTP or HTTPS URL without credentials");

const paths = z.array(z.string().trim().startsWith("/").max(240)).max(20).default([]);
const siteCrawl = z.object({
  url: publicReference,
  includePaths: paths,
  excludePaths: paths,
  pageLimit: z.number().int().min(1).max(50).default(20),
  crawlDepth: z.number().int().min(0).max(5).default(2),
}).strict();
const article = z.object({ url: publicReference }).strict();
const file = z.object({
  filename: z.string().trim().min(1).max(160).regex(/^[^/\\\x00-\x1f]+\.(pdf|txt|md|markdown)$/i),
  data: z.string().min(4).max(7_000_000),
}).strict();
const manual = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(120_000),
  url: publicReference.optional(),
}).strict();
const settings = {
  name: z.string().trim().min(1).max(120),
  visibility: z.enum(["private", "public"]).default("private"),
  syncHours: z.number().int().min(6).max(720).nullable().default(null),
};
export const sourceInput = z.discriminatedUnion("type", [
  z.object({ ...settings, type: z.literal("website"), config: siteCrawl }).strict(),
  z.object({ ...settings, type: z.literal("url"), config: article }).strict(),
  z.object({ ...settings, type: z.literal("file"), config: file }).strict(),
  z.object({ ...settings, type: z.literal("manual"), config: manual }).strict(),
]);
export type SourceInput = z.infer<typeof sourceInput>;
export type SourceConfig = SourceInput["config"];
export const retrievalInput = z.object({
  question: z.string().trim().min(1).max(1200),
  sourceIds: z.array(z.string().min(1).max(64)).max(30).optional(),
  topK: z.number().int().min(1).max(12).default(6),
}).strict();

export interface KnowledgeDocument {
  key: string;
  title: string;
  url: string | null;
  sections: { heading: string | null; content: string }[];
}

export class KnowledgeError extends Error {
  constructor(readonly code: string, readonly retryable = false) {
    super(code);
  }
}
