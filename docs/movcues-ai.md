# Movcues AI

Movcues AI is an authenticated, site-scoped product analytics assistant. It reuses the analytics catalog, Event Explorer, session events, experience analytics, and the existing Dashboard, Segment, and Funnel validation/entitlement paths.

## Configuration

All provider configuration is backend-only:

```env
AI_ENABLED=true
AI_PROVIDER=vertex
AI_DAILY_TOKEN_LIMIT=250000
AI_MAX_CONTEXT_CHARS=60000

VERTEX_PROJECT=
VERTEX_LOCATION=us-central1
VERTEX_MODEL=gemini-2.5-flash

OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
```

Vertex uses Google Application Default Credentials. On Railway, mount a service-account credential and set `GOOGLE_APPLICATION_CREDENTIALS`, or use workload identity where available. Never expose either provider credential as a `VITE_*` variable.

## Security and behavior

- Every route requires dashboard authentication, organization membership, and a site belonging to that organization.
- Conversations are private to their creating dashboard user and scoped to one organization/site.
- Context is built deterministically from existing services. Personal identifiers and raw event properties are removed before provider submission.
- Resource proposals are validated, previewed, stored as pending approvals, and require an ADMIN approval request before creation.
- Approval writes run transactionally and are idempotent.
- Requests are rate limited and workspace provider tokens are capped per UTC day.
- Analytics content is treated as untrusted data. The provider receives no SQL tool and cannot publish, pause, or delete experiences.

## Retention

Conversation and audit records currently follow workspace retention and are cascade-deleted when their owning organization/site/user is deleted. Raw analytics datasets are not copied into AI message storage. A scheduled age-based cleanup policy should be added before long-term enterprise retention requirements are enabled.

## Limitations

Provider credentials were not available in automated verification, so external Vertex/OpenAI calls require deployment smoke testing. Automated tests use a deterministic provider. Responses are request/response rather than token-streamed. Session evidence is based on persisted activity, not rrweb replay, and analytical findings do not claim causal impact.
