# Geo Agent Phase 3 guide skills

Administrators can approve a published guide as a searchable workflow, select it for a Geo Agent widget, and inspect recommendations in dashboard preview. Visitor chat continues using schema 1 and returns an empty `actions` array.

## Guide and skill lifecycle

A skill has a stable ID per guide and a new revision when approved metadata or the published guide version changes. Its record owns the org and site, points to the exact published Experience version, and holds approved metadata, entry path, content hash, indexing state, lease, model key, and timestamps. Selectors and executable steps remain in the versioned guide. Migration `0043_agent_skills.sql` adds the registry and a nullable diagnostics field to Geo turns. Existing guides start without a skill.

From **Review and publish**, enable **Make this guide available to Geo Agent** and review the metadata. Alternatively, open **Geo Agent availability** in the editor for an existing published guide. Suggestions use the existing administrative AI provider with rate limits, a timeout, and the organization’s daily usage ledger. The endpoint validates structured output and supplies editable starter metadata when the provider is unavailable or the output is invalid. The indexed record stores the administrator-approved metadata.

Guide publication and opt-in share a transaction. Admin edits compare the current published version and prior skill revision. The indexing lease checks the same revision and a worker claim token when it completes. Registration is idempotent. The worker reuses embeddings for unchanged search text and refreshes them when the configured model key changes. From the guide editor, refresh status or save again to retry after an indexing failure.

Each republish creates a new Experience version. Opt into skill availability for the new version in review, or approve it afterward in the guide editor. The previous reference immediately becomes unavailable. Pause, unpublish, and delete suppress retrieval. Disabling retains the stable ID and approved metadata.

## Retrieval, eligibility and answers

The existing Knowledge Engine still retrieves documents. Workflow retrieval searches up to 500 explicitly selected IDs within the current site and organization. It combines lexical matching on approved metadata with native libSQL cosine distance when a matching OpenAI model key is configured. Both systems reuse the HTTP embedding adapter. A separate vector service is unnecessary. When query embeddings fail, search can continue with keywords.

Ranking checks action compatibility, task nouns, and qualifiers. It can clarify an ambiguous request and abstain on unsupported or bulk destructive requests. Scores indicate relative relevance. The built-in action and synonym vocabulary is English-oriented. Follow-up resolution uses the previous question for supported forms, such as “Can you show me how?”

Eligibility checks scope, selection, approval, readiness, current guide publication, origin, schedule, and audience. Segment tests use the existing verified customer identity mechanism. Free-text preconditions without a verifier prevent visitor recommendations. A visitor may ask about a guide from a different entry page while meeting the widget’s own targeting rules. The service revalidates the selected guide before using its metadata and after generation.

The versioned internal recommendation is derived from validated retrieval and identifies the selected skill ID and revision. The language model does not supply IDs. With documentation, Geo uses the existing grounded generation and citation path. When only a skill matches, the service can return the approved summary. A future execution phase can consume the recommendation after fresh eligibility validation.

## Dashboard diagnostics and retention

Select skills in the Geo Agent editor’s **Skills** tab. Open **Test context** in Live preview to choose admin diagnostics or simulated visitor. Visitor mode tests draft widget targeting with a page URL and, when needed, a customer-issued signed identity. Admin mode inspects relevant candidate names and scoped rejection codes without granting visitor identity.

**Retrieval diagnostics** shows ranked candidates, exclusion reasons, document excerpts, the recommendation or clarification, and retrieval time. Preview does not create production conversations. Completed public turns store scoped diagnostics and token usage with existing retention. Recommendation data stays outside public replay and history and does not count as guide execution.

## Configuration and verification

Apply the new migration before starting the Phase 3 backend. Enable `KNOWLEDGE_WORKER_ENABLED=true` on the indexing process. Configure the existing administrative AI provider for suggestions and grounded answers. Optional embeddings use `OPENAI_API_KEY` and the existing `KNOWLEDGE_EMBEDDING_MODEL`, `KNOWLEDGE_EMBEDDING_DIMENSIONS`, and `KNOWLEDGE_EMBEDDING_VERSION` settings. The default is `text-embedding-3-small` at 512 dimensions. The default shortlist is 64 via `GEO_SKILL_MAX_CANDIDATES`. The default score threshold is 0.57 via `GEO_SKILL_RELEVANCE_THRESHOLD`.

~~~bash
npm ci
npm run build
npm test
NODE_ENV=test npx vitest run tests/agent-skills-ranking.test.ts --disableConsoleIntercept
NODE_ENV=test node --import tsx scripts/benchmark-geo-skills.ts
~~~

The dataset labels 52 supported and 20 unsupported queries across ten workflows. Keyword fixtures scored 51/52 for top-1 and top-3, 0.981 MRR, 0/20 false recommendations, and 20/20 correct abstentions. “Can I update an invice?” abstained because the typo maps ambiguously. Distinct integration cases exercise cross-org and signed visitor authorization. Mock vectors exercise native cosine retrieval and fallback.

### Local performance

Thirty timed turns per fixture, after warm-up. Combined retrieval is a mean. Other latency entries are p50/p95 in milliseconds. Mock tokens use a whitespace estimate plus fixed output. These numbers measure local libSQL and the mock provider.

| Selected skills | Index per skill | Keyword | Native cosine | Hybrid | Combined retrieval | First delta | Full answer | Mock tokens per turn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0, documents only | — | — | — | — | 6.21 | 5.04 / 13.94 | 5.07 / 13.97 | 31 |
| 10 | 2.32 / 3.07 | 5.11 / 6.01 | 1.32 / 1.45 | 6.38 / 11.76 | 12.85 | 12.51 / 21.82 | 15.13 / 23.53 | 46 |
| 100 | 1.86 / 6.28 | 8.43 / 62.42 | 8.36 / 13.04 | 12.29 / 18.81 | 24.21 | 24.79 / 37.01 | 26.99 / 39.85 | 46 |
| 500 | 2.56 / 3.45 | 25.43 / 27.14 | 39.18 / 50.04 | 65.66 / 78.04 | 60.00 | 52.70 / 74.57 | 54.56 / 77.08 | 46 |

Native cosine is exhaustive within the bounded selection. Only shortlisted definitions are read for eligibility. At most one approved workflow summary is sent to the generation provider. A turn may perform separate document and skill query embeddings. Live provider quality and latency and remote Turso latency require separate measurement.

### Manual acceptance checklist

- [ ] Publish an ordinary guide and confirm its absence from Skills.
- [ ] Publish a guide with availability enabled after reviewing suggested or manually entered metadata.
- [ ] Enable or disable availability for a previously published guide. Refresh to inspect indexing status.
- [ ] Select a ready skill in Geo Agent, save the draft and publish.
- [ ] Ask for the workflow and a follow-up. Inspect the recommendation and answer.
- [ ] Try an informational question, an ambiguous billing query, and a bulk destructive request.
- [ ] Test a segment-restricted guide with an unsigned visitor and an eligible customer-signed identity.
- [ ] Test the same guide from another starting page where the widget is permitted.
- [ ] Republish without skill approval, pause, and delete a test guide. Confirm exclusion.
- [ ] Test the public widget’s citations, empty actions, and absence of guide launch UI.
- [ ] Confirm admin preview left visitor conversation metrics unchanged.
