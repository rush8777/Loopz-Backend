# Shared Knowledge Engine

Workspace owners and administrators manage knowledge from the dashboard’s Knowledge page. Sources belong to one site and are private to administrators by default. Explicit visitor access marks a source as eligible for consumer features that enforce that permission. Treat every source excerpt as untrusted reference text.

## Setup

Use Node 22.13 or later. Run `npm ci`, build with `npm run build` and apply migrations with `npm run db:migrate` against the intended environment. The server also applies migrations at startup. Migration `0041_knowledge_engine` adds `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` and `knowledge_sync_jobs`.

Set `KNOWLEDGE_WORKER_ENABLED=true` on an API process to start the worker. It leases one job at a time per process from SQLite or Turso. Multiple processes may claim different jobs. Configure `OPENAI_API_KEY` for semantic search with OpenAI embeddings. A deployment with no key provides keyword retrieval. Set the embedding model, dimensions and version as shown in `.env.example`. Model, dimension, version and chunk configuration changes take effect for a source on its next successful synchronization. Schedule or trigger synchronization for existing sources after such a change.

## Import and synchronization

A website source discovers pages from the root sitemap and links within the configured origin and path scope. Path inclusions and exclusions match whole path prefixes. A URL source imports one article. Both sources support manual and scheduled synchronization. Static HTML, plain text and Markdown are supported on public websites. The crawler cannot import authenticated or JavaScript-only pages. Configure the final documentation hostname when a site redirects across hosts.

Uploads accept UTF-8 TXT and Markdown and text-based PDF. PDFs are parsed in a bounded subprocess with a scrubbed environment. Scanned and encrypted PDFs need a text export. The file byte limit is configurable. Manual articles accept a title, body and optional HTTP or HTTPS reference.

At most 30 sources are allowed per site. Website imports cap pages at 50 per sync. The worker normalizes and deduplicates documents, retains headings, chunks paragraphs and embeds changed documents in batches. Old content remains active until a single transaction activates a successful revision. The transaction also removes superseded content. A retryable failure backs off for up to three lease attempts. Interrupted processing is recovered after lease expiry. Disabled, excluded and deleted content is removed from retrieval immediately.

## Retrieval and API

Use Test retrieval to inspect the top relevant excerpts. Keyword search is available without a provider. When the configured embedding model matches the active revision, retrieval also ranks by native libSQL cosine similarity. The query scopes both result sets to the site and organization. Only active revisions and enabled sources are searched. An empty result indicates insufficient evidence.

All endpoints are under `/orgs/:orgId/sites/:siteId/knowledge` and require the administrator role. Use `GET/POST /sources`, `GET/PATCH/DELETE /sources/:sourceId`, `POST /sources/:sourceId/sync`, `GET /sources/:sourceId/jobs/:jobId`, `POST /sources/:sourceId/jobs/:jobId/cancel`, `GET /sources/:sourceId/documents`, `PATCH /sources/:sourceId/documents/:documentId` and `POST /retrieve`.

The crawler verifies permitted URLs and resolved addresses on every redirect and pins the connection to a validated address while preserving TLS validation. It bounds response sizes, time and crawl depth. Extracted text is rendered as text in the dashboard. It contains no executable page content.

## Verification

Run `npm test -- tests/knowledge.test.ts` for local libSQL migrations, source adapters, isolated network controls, hybrid search, tenant access and lifecycle tests. The tests use a fake embedding provider and controlled HTTP responses. Verify the vector query and live provider against the staging database before enabling production ingestion.
