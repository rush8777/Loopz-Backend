# Geo Agent

Geo Agent is a versioned `geo_agent` widget in Experiences. It uses the existing create, save, review, publish, pause and delete lifecycle. Its editor is a dedicated dashboard configuration page. The customer-facing answer service shares the AI provider transport with dashboard Geo and runs its own instructions, knowledge retrieval, usage accounting and visitor authentication. It has no tools or administrative capabilities.

## Set up an assistant

1. Start the backend on Node 22.13 or later. Apply `0041_knowledge_engine` and `0042_geo_agent` on a staging database first. The latter extends the SQLite widget-type check by copying the Experiences table transactionally and checking row counts before committing. Configure the [Knowledge Engine](knowledge-engine.md), enable `KNOWLEDGE_WORKER_ENABLED` and set up the desired `AI_PROVIDER` with `AI_ENABLED=true`. An OpenAI API key can independently enable semantic retrieval when the answer provider is Gemini or Vertex.
2. Open Knowledge, add your sources and wait until they finish indexing. Give visitor access only to articles suitable for customer-facing answers. Use Test retrieval to inspect the excerpts.
3. Open Experiences, then Other, then Geo Agent. Add an assistant name, theme, launcher settings, a welcome message and questions. Select sources in Knowledge. Configure allowed pages, audience and navigation persistence in Behavior.
4. Try an answer in Live preview. Save and review the current draft revision, then publish. Only the published version is used on the customer site. Leaving the sources empty produces the configured fallback. Pausing is available from the editor and list.
5. Serve the SDK artifacts from one versioned build directory, including `sdk-experiences*.js` and `sdk-geo-agent*.js`. The IIFE runtime derives a sibling URL. Custom distributions can set `geoAgent.bundleUrl`. The npm and ESM build uses a separate dynamic chunk.

## Visitor permissions

The public manifest supplies a single eligible launcher, ordered by descending priority and then by experience ID. It exposes appearance and persistence details. Source IDs, site instructions, identity keys and targeting rules stay on the server. The anonymous visitor session is an eight-hour, widget/version/origin-scoped bearer credential. It starts with a random owner identifier. An SDK site ID and an analytics user ID cannot establish ownership.

Segment-targeted assistants require verified customer identity. Generate an Ed25519 key pair in your application and paste the public PEM into Geo Agent's Behavior tab. Your application server verifies its own logged-in user and signs a short-lived JWT with the private key. Use header `alg: EdDSA`, an `iss` equal to the SDK site ID, `aud: movcues-geo-agent`, `sub` equal to the external user ID used by Movcues identify, and an `exp` no more than five minutes in the future. Return that token from an authenticated application endpoint and configure the SDK's `geoAgent.identityToken` callback to fetch it. Call `analytics.identify` after successful sign-in and `analytics.reset()` on logout. A verified Movcues visitor session expires after 15 minutes. The SDK verifies identity again after a full page reload before restoring a verified conversation. Retrieval from visitor chat is limited to visitor-accessible sources, including for verified visitors.

Page and audience eligibility, session scope and version are checked server-side for every visitor operation. The launcher is reconciled on delivery refreshes and once a minute while mounted on a visible page. On navigation, the page-only persistence option clears the in-memory chat. Tab persistence uses the site's session storage, scoped to the installation, widget version and current SDK identity. The stored credential never goes into the DOM or general analytics.

## Conversation endpoints

Visitor routes are under `/public/sites/:siteId/geo-agent/:experienceId`.

| Method and path | Operation |
| --- | --- |
| POST `/session` | Exchange the current page URL and optional verified identity for a visitor token |
| POST `/conversations` | Start an empty conversation |
| GET / DELETE `/conversations/:conversationId` | Restore the conversation or delete it and its turns |
| POST `/conversations/:conversationId/messages` | Send a question with a client-generated UUID and stream the answer |
| POST `/conversations/:conversationId/messages/:requestId/cancel` | Cancel the running turn |
| PUT `/conversations/:conversationId/messages/:messageId/feedback` | Upsert helpful or unhelpful feedback |
| POST `/events` | Record a launcher, interaction, citation or chat reset event |

Every visitor route after session creation takes the current page URL as the `url` query parameter and the visitor bearer token in Authorization. The server validates the request Origin against the configured site. Chat responses use NDJSON with separate started, delta, citations, complete and error frames. The version 1 completion carries `conversationId`, `messageId`, `message`, validated `citations` and an empty `actions` array. Future structured actions will require a new server-side registration and authorization contract.

An administrator can POST `/geo-agent/preview` and GET `/geo-agent/metrics` under the ordinary authenticated experience URL. Preview calls use independent request handling and do not persist conversations, events or production usage. The metrics expose aggregate counts, latency, knowledge coverage, token usage and helpfulness for retained conversations. The SDK renders chat text and trusted citation links with DOM APIs. Raw visitor questions and answers are stored only in the conversation records.

## Limits and data

Migration `0042_geo_agent` adds `geo_agent_conversations`, `geo_agent_turns` and `geo_agent_usage`. Feedback is a field on a completed turn. Message UUIDs are scoped to a conversation and duplicate completed requests return the same answer. Usage is reserved transactionally per site and calendar day. `GEO_AGENT_DAILY_TOKEN_LIMIT` defaults to 250,000. Interrupted provider calls retain their reservation because the final billed usage may be unknown. Conversation retention defaults to 30 days of inactivity and is configurable through `GEO_AGENT_RETENTION_DAYS`. New chat starts a new thread and leaves earlier data for expiry. The conversation deletion endpoint erases the selected thread immediately.

## Tests

Run `npm test` and `npm run build` in each repository. From SDK, `npm run test:browser` runs the SDK browser suites. `npm run test:integration` expects the Backend and Frontend checkouts in sibling directories named `Loopz-Backend` and `Loopz-Frontend`. The integration runner injects mock providers and disposable local databases. For a targeted Geo Agent run:

```sh
GEO_AGENT_INTEGRATION=true KNOWLEDGE_WORKER_ENABLED=true npx playwright test --config playwright.integration.config.ts tests/integration/geo-agent.spec.ts
```

Before a staged release, verify native vector retrieval and the table rebuild against a representative Turso database. Exercise live OpenAI, Gemini or Vertex credentials through the chosen deployment's network. Provider throughput and model grounding quality depend on the configured model and documentation.
