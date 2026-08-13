import { customAlphabet } from "nanoid";

// Lowercase alphanumeric only - safe to embed in URLs, query params, and
// SDK config without escaping.
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nanoid = customAlphabet(alphabet, 24);

/** Generates a new public site identifier, e.g. "site_9f2ab7c1e4..." - this is the SDK's `siteId`. */
export function generateSitePublicId(): string {
  return `site_${nanoid()}`;
}
