import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { KnowledgeError } from "./contracts.js";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PUBLIC_PORTS = { "https:": "443", "http:": "80" } as const;

export function crawlUrl(input: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(input, base); }
  catch { throw new KnowledgeError("invalid_url"); }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || (url.port && url.port !== PUBLIC_PORTS[url.protocol])
    || url.username || url.password || url.href.length > 2048
    || isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".")
    || /\.(localhost|local|internal|home\.arpa|test|invalid)\.?$/i.test(url.hostname)
  ) throw new KnowledgeError("blocked_url");
  url.hostname = url.hostname.replace(/\.$/, "");
  url.hash = "";
  return url;
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== "unicast") return false;
  if (parsed.kind() === "ipv6") {
    // Require a globally routable IPv6 prefix in addition to the library's special-range checks.
    const ipv6 = parsed as ipaddr.IPv6;
    return ipv6.match(ipaddr.IPv6.parse("2000::"), 3);
  }
  return true;
}

type ResolvedAddress = { address: string; family: number };
type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;
type HttpResult = { status: number; location?: string; type?: string; body?: Buffer };
type Connect = (url: URL, pinned: ResolvedAddress, types: ReadonlySet<string>, signal: AbortSignal) => Promise<HttpResult>;

const MAX_BYTES = 1_500_000;
const connect: Connect = (url, pinned, types, signal) => new Promise((resolve, reject) => {
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    agent: false,
    family: pinned.family,
    signal,
    headers: { accept: [...types].join(", "), "accept-encoding": "identity", "user-agent": "MovcuesKnowledge/1.0" },
    // The connection uses the address that was just validated. Host and TLS validation still use the URL hostname.
    lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
  }, response => {
    const status = response.statusCode ?? 502;
    if (status !== 200) {
      resolve({ status, location: response.headers.location });
      response.destroy();
      return;
    }
    const type = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    const encoding = response.headers["content-encoding"];
    if (!type || !types.has(type) || (encoding && encoding !== "identity")) {
      reject(new KnowledgeError("unsupported_content_type"));
      response.destroy();
      return;
    }
    if (Number(response.headers["content-length"]) > MAX_BYTES) {
      reject(new KnowledgeError("response_too_large"));
      response.destroy();
      return;
    }
    const buffers: Buffer[] = [];
    let bytes = 0;
    response.on("error", reject);
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        reject(new KnowledgeError("response_too_large"));
        response.destroy();
      } else buffers.push(chunk);
    });
    response.on("end", () => resolve({ status, type, body: Buffer.concat(buffers) }));
  });
  request.on("error", reject);
  request.end();
});

export function createKnowledgeFetcher(
  resolve: Resolve = hostname => lookup(hostname, { all: true }),
  open: Connect = connect,
) {
  return async (start: URL, types: ReadonlySet<string>, parent: AbortSignal, allowed: (url: URL) => boolean) => {
    let url = crawlUrl(start.href);
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
    try {
      for (let redirects = 0; redirects <= 4; redirects++) {
        signal.throwIfAborted();
        if (!allowed(url)) throw new KnowledgeError("out_of_scope");
        const addresses = await new Promise<ResolvedAddress[]>((resolveAddresses, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void resolve(url.hostname).then(resolveAddresses, reject).finally(() => signal.removeEventListener("abort", abort));
        });
        if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new KnowledgeError("blocked_address");
        const response = await open(url, addresses[0], types, signal);
        if (!REDIRECTS.has(response.status)) return { ...response, url };
        if (!response.location) throw new KnowledgeError("invalid_redirect");
        const next = crawlUrl(response.location, url);
        if (url.protocol === "https:" && next.protocol !== "https:") throw new KnowledgeError("invalid_redirect");
        url = next;
      }
      throw new KnowledgeError("too_many_redirects");
    } catch (error) {
      parent.throwIfAborted();
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError("fetch_failed", true);
    }
  };
}

export type KnowledgeFetch = ReturnType<typeof createKnowledgeFetcher>;
