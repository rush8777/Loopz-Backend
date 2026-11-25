import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { closeDb, createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { knowledgeChunks, knowledgeDocuments, knowledgeSources, knowledgeSyncJobs, memberships } from "../src/db/schema.js";
import { sourceInput } from "../src/lib/knowledge/contracts.js";
import { chunkDocument, extractHtml } from "../src/lib/knowledge/extract.js";
import { crawlUrl, createKnowledgeFetcher, isPublicAddress } from "../src/lib/knowledge/http.js";
import { processKnowledgeJob } from "../src/lib/knowledge/jobs.js";
import { retrieveKnowledge } from "../src/lib/knowledge/retrieval.js";
import { knowledgeFileBytes, readSource } from "../src/lib/knowledge/sources.js";

const signal = new AbortController().signal;
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

function pdfFixture() {
  const content = "BT /F1 16 Tf 30 150 Td (Invoices are saved in Billing.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe("Knowledge source adapters", () => {
  it("permits public DNS destinations only and passes the validated address to transport", async () => {
    expect(() => crawlUrl("file:///var/data")).toThrow("blocked_url");
    expect(() => crawlUrl("https://docs.example.com:8443")).toThrow("blocked_url");
    expect(() => crawlUrl("https://example.local")).toThrow("blocked_url");
    for (const address of ["127.0.0.1", "10.10.0.5", "169.254.169.254", "192.168.1.2", "::1", "fc00::1", "::ffff:127.0.0.1"]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    const open = vi.fn().mockResolvedValue({ status: 200, body: Buffer.from("OK"), type: "text/plain" });
    const url = crawlUrl("https://docs.example.com");
    const types = new Set(["text/plain"]);
    await createKnowledgeFetcher(publicDns, open)(url, types, signal, () => true);
    expect(open).toHaveBeenCalledWith(url, { address: "93.184.216.34", family: 4 }, types, expect.any(AbortSignal));
    open.mockClear();
    await expect(createKnowledgeFetcher(async () => [...await publicDns(), { address: "10.0.0.5", family: 4 }], open)
      (url, types, signal, () => true)).rejects.toThrow("blocked_address");
    expect(open).not.toHaveBeenCalled();
  });

  it("checks the scope and DNS of redirected destinations before transport", async () => {
    const resolve = vi.fn().mockImplementation(async hostname => hostname === "docs.example.com" ? publicDns() : [{ address: "::1", family: 6 }]);
    const open = vi.fn().mockResolvedValue({ status: 302, location: "https://redirect.example.com/help" });
    const fetch = createKnowledgeFetcher(resolve, open);
    const url = crawlUrl("https://docs.example.com");
    await expect(fetch(url, new Set(["text/plain"]), signal, next => next.hostname === url.hostname)).rejects.toThrow("out_of_scope");
    expect(resolve).toHaveBeenCalledTimes(1);
    await expect(fetch(url, new Set(["text/plain"]), signal, () => true)).rejects.toThrow("blocked_address");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("combines sitemap and linked discovery, respects scope, and deduplicates canonical documents", async () => {
    const site = sourceInput.parse({ type: "website", name: "Docs", config: { url: "https://docs.example.com/help/", excludePaths: ["/help/archive"] } });
    const open = vi.fn().mockImplementation(async (url: URL) => {
      if (url.pathname === "/sitemap.xml") return {
        status: 200, type: "application/xml", body: Buffer.from("<urlset><url><loc>https://docs.example.com/help/invoices</loc></url><url><loc>https://docs.example.com/help/archive</loc></url></urlset>"),
      };
      return { status: 200, type: "text/html", body: Buffer.from(url.pathname === "/help/"
        ? '<h1>Help</h1><main><p>Browse the billable features.</p><a href="/help/invoices?utm_source=menu">Invoices</a><a href="/help/new">New</a><a href="https://other.example.com/help">Outside</a></main>'
        : '<link rel="canonical" href="/help/invoices"><article><h1>Invoices</h1><h2>Save an invoice</h2><p>Open billing and choose New invoice.</p><script>excluded payload</script></article>') };
    });
    const output = await readSource(site, createKnowledgeFetcher(publicDns, open), signal, async () => {}, 10000);
    expect(output.map(document => document.key)).toEqual(["https://docs.example.com/help", "https://docs.example.com/help/invoices"]);
    expect(output[1].sections).toEqual([{ heading: "Save an invoice", content: "Open billing and choose New invoice." }]);
    expect(open.mock.calls.map(([url]) => url.pathname)).toEqual(["/sitemap.xml", "/help/", "/help/invoices", "/help/new"]);
    const chunks = chunkDocument({ ...output[1], sections: [{ heading: "Billing", content: ("First paragraph explains the required invoice fields.\n\n").repeat(35) }] }, 40, 8);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.heading === "Billing" && chunk.content.split(/\s+/).length <= 40)).toBe(true);
    expect(extractHtml("<body><nav>Ignore me</nav><main><p>Read me</p></main></body>", "Help").sections[0].content).toBe("Read me");
  });

  it("imports PDF, Markdown and UTF-8 text, and validates bytes and size", async () => {
    for (const [filename, bytes, text] of [
      ["help.pdf", pdfFixture(), "Invoices are saved in Billing."],
      ["help.md", Buffer.from("# Payments\nPay with a card."), "Pay with a card."],
      ["help.txt", Buffer.from("Search by invoice number."), "Search by invoice number."],
    ] as const) {
      const source = sourceInput.parse({ type: "file", name: filename, config: { filename, data: bytes.toString("base64") } });
      const documents = await readSource(source, createKnowledgeFetcher(), signal, async () => {}, 10000);
      expect(documents[0].sections.map(section => section.content).join(" ")).toContain(text);
    }
    expect(() => knowledgeFileBytes({ filename: "fake.pdf", data: "c29tZQ==" }, 10000)).toThrow("invalid_pdf");
    expect(() => knowledgeFileBytes({ filename: "large.txt", data: "c29tZQ==" }, 1)).toThrow("file_size_limit");
  });
});

describe("Knowledge Engine persistence and administration", () => {
  const db = createDb("file::memory:");
  let app: FastifyInstance;
  const urls: string[] = [];
  const scope: { orgId: string; siteId: string; authorization: string; userId: string }[] = [];
  const embed = vi.fn(async (texts: string[]) => ({
    vectors: texts.map(text => /invoice|bill|charge/i.test(text) ? [1, 0, 0] : [0, 0, 1]),
    tokens: texts.length * 7,
  }));
  const embedder = { key: "mock:3", dimensions: 3, embed };

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp(db, { knowledgeEmbedder: embedder });
    await app.ready();
    for (let index = 0; index < 2; index++) {
      const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email: `know-${index}@example.test`, password: "test-password-12345" } });
      expect(signup.statusCode).toBe(201);
      const { accessToken, user } = signup.json();
      const authorization = `Bearer ${accessToken}`;
      const result = await app.inject({
        method: "POST", url: "/auth/onboarding", headers: { authorization },
        payload: { workspaceName: `Workspace ${index}`, siteName: "Test site", domain: "https://example.test" },
      });
      expect(result.statusCode).toBe(201);
      const { organization, site } = result.json();
      scope.push({ orgId: organization.id, siteId: site.id, authorization, userId: user.id });
      urls.push(`/orgs/${organization.id}/sites/${site.id}/knowledge`);
    }
  });
  afterAll(async () => { await app?.close(); await closeDb(db); });

  it("queues, recovers, retrieves and updates active documents, and rejects cross-tenant access", async () => {
    const headers = { authorization: scope[0].authorization };
    const url = urls[0];
    const call = (method: "POST" | "PATCH" | "DELETE" | "GET", path: string, payload?: object) =>
      app.inject({ method, url: url + path, headers, payload });
    const create = await call("POST", "/sources", {
      type: "manual", name: "Billing help", config: { title: "Creating invoices", content: "# Billing\nOpen Billing and choose New invoice." },
    });
    expect(create.statusCode, create.body).toBe(201);
    const source = create.json().source;
    expect(source.status).toBe("queued");
    const job = source.job.id;
    expect((await call("POST", `/sources/${source.id}/sync`)).json().job.id).toBe(job);
    await db.update(knowledgeSyncJobs).set({ status: "processing", attempts: 1, leaseOwner: "previous-worker", leaseUntil: new Date(0) }).where(eq(knowledgeSyncJobs.id, job));
    expect(await processKnowledgeJob(db, embedder, signal)).toBe(true);
    expect((await call("GET", `/sources/${source.id}/jobs/${job}`)).json().job).toMatchObject({ attempts: 2, status: "succeeded", embeddingTokens: 7 });

    const scenarios = [
      ["Where are invoices created?", true],
      ["How can I bill a client?", true],
      ["Where is it?", false],
      ["How do I export an audit log?", false],
    ] as const;
    for (const [question, shouldMatch] of scenarios) {
      const response = await call("POST", "/retrieve", { question });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().matches.length > 0, question).toBe(shouldMatch);
    }
    const lexical = await retrieveKnowledge(db, null, { ...scope[0], question: "billing invoice", topK: 4 });
    expect(lexical.matches[0]).toMatchObject({ heading: "Billing", title: "Creating invoices", sourceId: source.id });
    expect((await retrieveKnowledge(db, embedder, { ...scope[0], publicOnly: true, question: "invoices", topK: 4 })).matches).toEqual([]);
    expect((await app.inject({ method: "GET", url: `${urls[1]}/sources/${source.id}`, headers: { authorization: scope[1].authorization } })).statusCode).toBe(404);
    expect((await retrieveKnowledge(db, embedder, { ...scope[1], question: "invoices", sourceIds: [source.id], topK: 4 })).matches).toEqual([]);

    embed.mockClear();
    expect((await call("POST", `/sources/${source.id}/sync`)).statusCode).toBe(202);
    expect(await processKnowledgeJob(db, embedder, signal)).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    const document = (await call("GET", `/sources/${source.id}/documents`)).json().documents[0];
    expect((await call("PATCH", `/sources/${source.id}/documents/${document.id}`, { excluded: true })).statusCode).toBe(200);
    expect((await call("POST", "/retrieve", { question: "invoices" })).json().matches).toEqual([]);
    await call("PATCH", `/sources/${source.id}/documents/${document.id}`, { excluded: false });

    expect((await call("PATCH", `/sources/${source.id}`, { config: { title: "Payment cards", content: "Add a card in Settings." } })).statusCode).toBe(200);
    embed.mockRejectedValueOnce(new Error("Temporary provider failure"));
    expect(await processKnowledgeJob(db, embedder, signal)).toBe(true);
    expect((await call("POST", "/retrieve", { question: "invoices" })).json().matches).toHaveLength(1);
    expect(await processKnowledgeJob(db, embedder, signal, createKnowledgeFetcher(), () => new Date(Date.now() + 90_000))).toBe(true);
    expect((await call("POST", "/retrieve", { question: "invoices" })).json().matches).toEqual([]);
    expect(await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.sourceId, source.id))).toHaveLength(1);
    await call("PATCH", `/sources/${source.id}`, { enabled: false });
    expect((await call("POST", "/retrieve", { question: "payment cards" })).json().matches).toEqual([]);
    expect((await call("DELETE", `/sources/${source.id}`)).statusCode).toBe(204);
    expect(await db.select().from(knowledgeChunks)).toEqual([]);
  });

  it("rejects viewers and scopes job cancellation and scheduled imports", async () => {
    const headers = { authorization: scope[1].authorization };
    const created = await app.inject({
      method: "POST", url: `${urls[1]}/sources`, headers,
      payload: { type: "url", name: "Public docs", config: { url: "https://docs.example.com/help" }, syncHours: 6 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const source = created.json().source;
    const path = `${urls[1]}/sources/${source.id}/jobs/${source.job.id}/cancel`;
    expect((await app.inject({ method: "POST", url: path, headers })).statusCode).toBe(200);
    await db.update(knowledgeSources).set({ nextSyncAt: new Date(0) }).where(eq(knowledgeSources.id, source.id));
    const fetch = createKnowledgeFetcher(publicDns, async () => ({
      status: 200, type: "text/plain", body: Buffer.from("Learn to create a scheduled export."),
    }));
    expect(await processKnowledgeJob(db, null, signal, fetch)).toBe(true);
    expect((await app.inject({ url: `${urls[1]}/sources/${source.id}`, headers })).json().source).toMatchObject({ status: "ready", documentCount: 1 });
    await db.update(memberships).set({ role: "VIEWER" }).where(and(eq(memberships.orgId, scope[1].orgId), eq(memberships.userId, scope[1].userId)));
    expect((await app.inject({ url: `${urls[1]}/sources`, headers })).statusCode).toBe(403);
  });
});
