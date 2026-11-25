import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { KnowledgeError, type KnowledgeDocument } from "./contracts.js";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
const MAX_TEXT = 120_000;
const REMOVED = new Set(["script", "style", "template", "noscript", "nav", "footer", "aside", "svg", "form", "iframe"]);
const BLOCK = new Set(["p", "ul", "ol", "li", "div", "section", "blockquote", "pre", "br", "tr", "table"]);
const children = (node: HtmlNode): HtmlNode[] => "childNodes" in node ? node.childNodes : [];
const attr = (element: HtmlElement, name: string) => element.attrs.find(item => item.name === name)?.value;
const element = (node: HtmlNode): node is HtmlElement => "tagName" in node;
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim();

function elementsIn(root: HtmlNode, max = 40_000): HtmlElement[] {
  const pending = [root];
  const result: HtmlElement[] = [];
  let visited = 0;
  while (pending.length && visited++ < max) {
    const node = pending.pop()!;
    if (element(node)) result.push(node);
    const nodes = children(node);
    for (let i = nodes.length - 1; i >= 0; i--) pending.push(nodes[i]);
  }
  return result;
}

function textIn(root: HtmlNode): string {
  const pending: (HtmlNode | string)[] = [root];
  const pieces: string[] = [];
  let length = 0;
  while (pending.length && length < MAX_TEXT) {
    const node = pending.pop()!;
    if (typeof node === "string" || node.nodeName === "#text") {
      const text = typeof node === "string" ? node : (node as DefaultTreeAdapterMap["textNode"]).value;
      pieces.push(text);
      length += text.length;
      continue;
    }
    if (element(node) && (REMOVED.has(node.tagName) || attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true")) continue;
    const block = element(node) && (BLOCK.has(node.tagName) || /^h[1-6]$/.test(node.tagName));
    if (block) {
      pieces.push("\n");
      pending.push("\n");
      length++;
    }
    const nodes = children(node);
    for (let i = nodes.length - 1; i >= 0; i--) pending.push(nodes[i]);
  }
  return clean(pieces.join("").slice(0, MAX_TEXT).replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n"));
}

export function extractHtml(html: string, fallback: string) {
  const page = parse(html, { scriptingEnabled: false });
  const nodes = elementsIn(page);
  const body = nodes.find(node => node.tagName === "article") ?? nodes.find(node => node.tagName === "main" || attr(node, "role") === "main")
    ?? nodes.find(node => node.tagName === "body") ?? page;
  const headingNodes = ["h1", "h2", "h3", "h4", "h5", "h6"];
  const titleNode = nodes.find(node => node.tagName === "h1") ?? nodes.find(node => node.tagName === "title");
  const title = (titleNode && textIn(titleNode) || fallback).slice(0, 200);
  const links = nodes.filter(node => node.tagName === "a").map(node => attr(node, "href")).filter((href): href is string => Boolean(href)).slice(0, 1000);
  const canonical = nodes.find(node => node.tagName === "link" && attr(node, "rel")?.toLowerCase() === "canonical");
  const sections: KnowledgeDocument["sections"] = [];
  // Traverse containers to retain section boundaries while extracting only readable text.
  const pending = [...children(body)].reverse();
  let heading: string | null = null;
  let parts: string[] = [];
  let length = 0;
  const flush = () => {
    const content = clean(parts.join("\n\n"));
    if (content) sections.push({ heading, content });
    parts = [];
  };
  while (pending.length && length < MAX_TEXT) {
    const node = pending.pop()!;
    if (element(node)) {
      if (REMOVED.has(node.tagName) || attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true") continue;
      if (headingNodes.includes(node.tagName)) {
        flush();
        heading = textIn(node).slice(0, 200) || null;
        continue;
      }
      if (["main", "article", "div", "section", "header", "details"].includes(node.tagName)) {
        pending.push(...children(node).slice().reverse());
        continue;
      }
    }
    const content = textIn(node).slice(0, MAX_TEXT - length);
    if (content) { parts.push(content); length += content.length; }
  }
  flush();
  return { title, sections, links, canonical: canonical && attr(canonical, "href") };
}

export function extractText(content: string): KnowledgeDocument["sections"] {
  const sections: KnowledgeDocument["sections"] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    const content = lines.join("\n").trim();
    if (content) sections.push({ heading, content });
    lines = [];
  };
  for (const line of clean(content).slice(0, MAX_TEXT).split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const title = fenced ? null : /^#{1,6}\s+(.+)\s*$/.exec(line);
    if (title) { flush(); heading = title[1].slice(0, 200); }
    else lines.push(line);
  }
  flush();
  return sections;
}

export function documentHash(document: KnowledgeDocument): string {
  return createHash("sha256").update(JSON.stringify([document.title, document.sections])).digest("hex");
}

export function chunkDocument(document: KnowledgeDocument, size = 360, overlap = 40) {
  if (overlap < 0 || overlap >= size) throw new Error("invalid_chunk_window");
  const chunks: { heading: string | null; content: string }[] = [];
  for (const section of document.sections) {
    const segments = section.content.split(/\n{2,}|(?<=[.!?])\s+(?=\p{Lu})/u).flatMap(segment => {
      const pieces: string[] = [];
      const words = segment.match(/\S+/g) ?? [];
      for (let start = 0; start < words.length; start += size) pieces.push(words.slice(start, start + size).join(" "));
      return pieces.flatMap(piece => piece.match(/[\s\S]{1,6500}/gu) ?? []);
    });
    let parts: string[] = [];
    let length = 0;
    for (const segment of segments) {
      const words = segment.split(/\s+/);
      if (parts.length && (length + words.length > size || parts.join("\n\n").length + segment.length > 6500)) {
        chunks.push({ heading: section.heading, content: parts.join("\n\n") });
        const carry = parts.join(" ").split(/\s+/).slice(-overlap);
        parts = overlap && words.length + carry.length <= size && segment.length + carry.join(" ").length <= 6400 ? [carry.join(" ")] : [];
        length = parts.length ? carry.length : 0;
      }
      parts.push(segment);
      length += words.length;
    }
    if (parts.length) chunks.push({ heading: section.heading, content: parts.join("\n\n") });
    if (chunks.length > 160) throw new KnowledgeError("too_many_chunks");
  }
  return chunks;
}
