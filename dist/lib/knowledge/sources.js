import { KnowledgeError } from "./contracts.js";
import { documentHash, extractHtml, extractText } from "./extract.js";
import { crawlUrl } from "./http.js";
import { extractPdf } from "./pdf.js";
const pageTypes = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown"]);
const sitemapTypes = new Set(["text/xml", "application/xml", "text/plain"]);
const decoder = new TextDecoder("utf-8", { fatal: true });
export function knowledgeFileBytes(config, limit) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(config.data) || config.data.length % 4 !== 0)
        throw new KnowledgeError("invalid_file_encoding");
    const bytes = Buffer.from(config.data, "base64");
    if (!bytes.length || bytes.length > limit)
        throw new KnowledgeError("file_size_limit");
    if (/\.pdf$/i.test(config.filename)) {
        if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
            throw new KnowledgeError("invalid_pdf");
    }
    else {
        try {
            if (decoder.decode(bytes).includes("\u0000"))
                throw new Error();
        }
        catch {
            throw new KnowledgeError("invalid_text_file");
        }
    }
    return bytes;
}
function normalizedUrl(url) {
    const canonical = new URL(url);
    const tracking = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
    for (const key of tracking)
        canonical.searchParams.delete(key);
    canonical.searchParams.sort();
    if (canonical.pathname.endsWith("/") && canonical.pathname !== "/")
        canonical.pathname = canonical.pathname.slice(0, -1);
    return canonical.href;
}
function parseSitemap(body) {
    if (!/<(?:urlset|sitemapindex)(?:\s|>)/i.test(body) || /<!DOCTYPE|<!ENTITY/i.test(body))
        return { index: false, links: [] };
    const links = [...body.matchAll(/<loc\s*>([^<]{1,2048})<\/loc>/gi)].slice(0, 2000)
        .map(match => match[1].trim().replace(/&amp;/g, "&"));
    return { index: /<sitemapindex(?:\s|>)/i.test(body), links };
}
function parseUrl(input, base) {
    try {
        return crawlUrl(input, base);
    }
    catch {
        return null;
    }
}
function pathMatches(path, prefix) {
    return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}
export function validateSource(source, fileLimit) {
    if (source.type === "file")
        knowledgeFileBytes(source.config, fileLimit);
    if (source.type === "website" || source.type === "url")
        crawlUrl(source.config.url);
    if (source.syncHours !== null && source.type !== "website" && source.type !== "url")
        throw new KnowledgeError("schedule_requires_url");
}
export async function readSource(source, fetchPage, signal, progress, fileLimit) {
    if (source.type === "manual") {
        const { title, url, content } = source.config;
        return [{ key: "manual", title, url: url ?? null, sections: extractText(content) }];
    }
    if (source.type === "file") {
        const bytes = knowledgeFileBytes(source.config, fileLimit);
        const title = source.config.filename;
        const content = /\.pdf$/i.test(title) ? await extractPdf(bytes, signal) : decoder.decode(bytes);
        const sections = extractText(content);
        if (!sections.length)
            throw new KnowledgeError("no_indexable_text");
        return [{ key: "file", title, url: null, sections }];
    }
    const start = crawlUrl(source.config.url);
    const sameSite = (url) => url.hostname === start.hostname && (url.origin === start.origin || start.protocol === "http:" && url.protocol === "https:");
    const settings = source.type === "website" ? source.config : null;
    const sitePath = start.pathname.replace(/\/$/, "") || "/";
    const inScope = (url) => sameSite(url) && (!settings || !settings.excludePaths.some(path => pathMatches(url.pathname, path)) && (settings.includePaths.length ? settings.includePaths.some(path => pathMatches(url.pathname, path))
        : pathMatches(url.pathname, sitePath) || normalizedUrl(url) === normalizedUrl(start)));
    const queue = [];
    const seen = new Set();
    const hashes = new Set();
    const canonicalKeys = new Set();
    const documents = [];
    const limit = settings?.pageLimit ?? 1;
    const add = (url, depth) => {
        if (!url || queue.length >= limit * 10 || !inScope(url))
            return;
        const key = normalizedUrl(url);
        if (!seen.has(key)) {
            seen.add(key);
            queue.push({ url, depth });
        }
    };
    if (source.type === "url")
        add(start, 0);
    else {
        add(start, 0);
        const sitemapQueue = [new URL("/sitemap.xml", start)];
        const sitemapSeen = new Set();
        for (let index = 0; index < sitemapQueue.length && index < 6; index++) {
            signal.throwIfAborted();
            const url = sitemapQueue[index];
            if (sitemapSeen.has(url.href))
                continue;
            sitemapSeen.add(url.href);
            try {
                const response = await fetchPage(url, sitemapTypes, signal, sameSite);
                if (response.status !== 200 || !response.body)
                    continue;
                const sitemap = parseSitemap(response.body.toString("utf8"));
                for (const link of sitemap.links) {
                    const destination = parseUrl(link, response.url);
                    if (sitemap.index) {
                        if (destination && sameSite(destination) && sitemapQueue.length < 6)
                            sitemapQueue.push(destination);
                    }
                    else
                        add(destination, 0);
                }
            }
            catch {
                signal.throwIfAborted(); /* The linked-page crawler remains available. */
            }
        }
    }
    let livePages = 0;
    for (let cursor = 0; cursor < queue.length && cursor < limit; cursor++) {
        const { url, depth } = queue[cursor];
        signal.throwIfAborted();
        const response = await fetchPage(url, pageTypes, signal, inScope).catch(error => {
            if (settings && cursor > 0 && error instanceof KnowledgeError && error.code === "unsupported_content_type")
                return null;
            throw error;
        });
        if (!response)
            continue;
        if (response.status === 404 || response.status === 410)
            continue;
        if (response.status !== 200 || !response.body)
            throw new KnowledgeError("source_http_error", response.status >= 500 || response.status === 429);
        livePages++;
        const text = response.body.toString("utf8");
        const html = response.type === "text/html" || response.type === "application/xhtml+xml";
        const content = html ? extractHtml(text, response.url.pathname) : { title: response.url.pathname, sections: extractText(text), links: [], canonical: undefined };
        const canonical = content.canonical ? parseUrl(content.canonical, response.url) : null;
        const key = normalizedUrl(canonical && inScope(canonical) ? canonical : response.url);
        const document = { key, url: key, title: content.title, sections: content.sections };
        const hash = documentHash(document);
        if (content.sections.length && !canonicalKeys.has(key) && !hashes.has(hash)) {
            documents.push(document);
            hashes.add(hash);
            canonicalKeys.add(key);
        }
        if (settings && depth < settings.crawlDepth) {
            for (const link of content.links)
                add(parseUrl(link, response.url), depth + 1);
        }
        await progress(cursor + 1, Math.min(limit, queue.length));
    }
    // Confirmed removals produce an empty revision. An extraction failure preserves the active one.
    if (!documents.length && livePages)
        throw new KnowledgeError("no_indexable_text");
    return documents;
}
//# sourceMappingURL=sources.js.map