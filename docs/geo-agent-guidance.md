# Geo Agent Phase 4 interactive guidance

Phase 4 lets a visitor open an approved walkthrough explicitly from Geo Agent. It connects the Phase 3 skill registry, the currently published guide version, and the existing SDK ExperienceLoader. Flow Builder and Guided Capture continue to author the guide. Interactive guidance uses the guide’s published step order, page and element targets, delay, missing-target behavior, and theme.

## Setup

Apply migration `0046_geo_agent_guidance` before starting the Phase 4 API. The migration adds a guidance table and a nullable conversation retirement timestamp. Existing rows and answer-only widgets retain their behavior. Use the existing provider settings and `KNOWLEDGE_WORKER_ENABLED=true` for indexing approved skills. There are no new backend environment variables or package dependencies.

Publish and enable a guide skill, wait for indexing, and select it in **Geo Agent → Skills**. Enable **Allow visitors to launch guides** and publish the Geo Agent. Collapse-on-start and reopen-on-end both default on when guidance is enabled. Existing widgets must explicitly opt in and publish.

Serve the SDK files together from the same version. The existing lazy Geo bundle contains the guidance coordinator. The experience loader connects it with a typed internal bridge. A fresh tab without an eligible Geo Agent does not fetch that bundle. A tab with active guidance can reload the bundle on an approved continuation page where the launcher itself is excluded.

## Action and authorization boundary

The v1 NDJSON stream is unchanged. A completed answer can contain one structured action with `type: "start_guide"`, `label: "Guide me"`, an opaque `actionId`, and `expiresAt`. The UUID is an identifier, not a bearer credential. The existing signed Geo visitor session is required to exercise it. The server creates the action only for a validated deterministic Phase 3 recommendation. No model-generated tool output or launch URL participates.

All routes below are relative to `/public/sites/:siteId/geo-agent/:experienceId`. They use the same Origin, page URL, and visitor authorization contract as chat.

| Route | Purpose |
| --- | --- |
| POST `/conversations/:id/guidance` | Accept a completed turn’s recommendation and obtain a scoped session and entry decision |
| POST `/conversations/:id/guidance/:guidanceId/claim` | Launch, restore, or revalidate the exact guide within an accepted session |
| POST `/conversations/:id/guidance/:guidanceId/events` | Report bounded walkthrough lifecycle observations |
| POST `/conversations/:id/guidance/revoke` | Retire the conversation’s actions and active guidance on SDK identity change |

Acceptance requires the widget’s published version, selected skill and revision, live guide version, conversation owner, action age, and applicable audience, schedule and origin rules. Signed visitors must provide a fresh customer-issued proof at acceptance and after reload. A recommendation lives five minutes. Guidance lasts at most 30 minutes and no longer than the issuing visitor credential. The database allows one live session per site and visitor and one acceptance per turn. A retry with the same instance UUID returns the original session. A different instance cannot claim it. Browser Web Locks add a same-origin tab guard where supported.

Launch responses provide the existing published guide rendering definition to the authorized runtime. Recommendation and history payloads do not contain selectors, guide definitions, identities, or credentials. The coordinator only sends its stored visitor credential in an authorization header. Identity reset clears local progress and attempts authenticated retirement even during a page transition. Signed visitors still need current host proof to accept or restore if retirement could not be sent. The host should call the SDK reset/identity APIs on logout or account switch.

## Entry navigation and continuation

Explicit guidance honors initial guide page targeting and the first recorded target context. After launch, each configured step controls where and how it can appear. Manual guidance can run regardless of automatic launch trigger, impression frequency, and a prior walkthrough completion. Existing automatic delivery retains its own rules.

The server resolves the entry route from existing guide context, approved skill metadata and the guide’s configured build URL. It validates every destination against the site origin, the guide’s entry rules, and supported path and hash routes. Query strings and ordinary fragments are excluded from navigation offers. If a target needs an exact URL containing sensitive or variable parameters, Geo can start on that page when the visitor reaches it independently. It cannot construct those parameters.

Visitors click **Go to start page** to accept navigation. The default full-page navigation uses the browser’s existing unload guards. Hosts with SPA navigation guards can set `geoAgent.navigateToGuidanceEntry(url)` and return whether the router accepted the validated destination. Reload and back/forward use tab-scoped continuation plus fresh server checks. An accepted walkthrough may continue off the launcher’s page rules without expanding where the widget itself appears. Page-only chat still starts a new conversation on the new page.

A different active guide prompts the visitor to continue it or switch. Other active experiences must be closed first. Missing targets and configured skips use the existing guide policies. Local cancellation is scoped to the specific guidance instance. Reload and route changes revalidate, as do lifecycle requests and the existing visible Geo refresh. No extra background polling is added. An off-launcher view has a cancellation control while a guide is active.

## Progress, analytics and theme

The server derives bounded answer context from an authorized session. It contains the approved skill name, step number, total, and waiting or in-progress state. The integration does not send host form data, screenshots, or DOM contents. Progress and outcome text are deterministic and incur no model calls. Completion means the walkthrough finished. Browser events never establish verified product success.

The existing Geo Agent metrics endpoint adds counts for guidance recommendations, acceptance, start, failure, missing targets, observed step advancement, recovery, cancellation and walkthrough completion. Existing guide impression events remain in the existing guide pipeline. Guidance records follow conversation retention and are removed when the thread is deleted. Admin preview provides launch availability and entry diagnostics without creating executable recommendations or production telemetry.

The dashboard can snapshot a saved Theme Studio design system into the chatbot draft. Theme Studio also renders an inert Geo Agent sample using the SDK. Published snapshots remain fixed and explicit chat branding remains configurable. Guides keep their own published styling.

## Verification and acceptance

~~~sh
npm ci
npm run build
npm test
~~~

From the SDK checkout with backend and frontend in the expected sibling directories, run the disposable invoice fixture.

~~~sh
GEO_AGENT_INTEGRATION=true KNOWLEDGE_WORKER_ENABLED=true npx playwright test --config playwright.integration.config.ts tests/integration/geo-guidance.spec.ts
~~~

- [ ] Confirm an existing Geo Agent still answers normally before enabling guidance.
- [ ] Publish an eligible guide, wait for its skill to index, and publish Geo Agent with guidance enabled.
- [ ] From another page, ask “I need to bill a customer”. Confirm the site stays put until you approve the entry-page prompt.
- [ ] Follow a multi-page guide with manual actions. Reload and ask Geo which step is active.
- [ ] Cancel the walkthrough and check that the chat and earlier messages are available according to the widget’s configured persistence.
- [ ] Test a missing target, stale recommendation, paused widget, republished guide and restricted audience.
- [ ] Compare the walkthrough and product form. Only your interaction should be able to fill or submit the form.
- [ ] Verify completion metrics mean walkthrough completion, then check chat and guide appearance with different saved themes.
- [ ] Confirm admin preview leaves visitor guidance, impressions and conversation counts unchanged.

Live providers, hosted Turso performance and application-specific router guards need staging validation. A future trusted task-completion integration can link separately verified host evidence to a guidance session.

## Bundle measurements

The usual SDK build was run at the fetched Theme Studio base and again with Phase 4. The sizes below are bytes. Gzip was measured locally with `gzip -n`.

| Asset | Base raw / gzip | Phase 4 raw / gzip |
| --- | ---: | ---: |
| Core | 82,329 / 20,412 | 82,329 / 20,412 |
| Core minified | 47,205 / 14,772 | 47,205 / 14,772 |
| Experiences | 154,740 / 32,495 | 162,566 / 34,058 |
| Experiences minified | 92,182 / 25,394 | 97,213 / 26,611 |
| Geo Agent lazy module | 21,660 / 6,324 | 49,125 / 12,032 |
| Geo Agent lazy module minified | 14,557 / 5,297 | 32,120 / 10,100 |

Guidance uses the existing lazy module and has no new standalone customer asset. The browser fixture records click-to-render timing for authorized entry navigation. These are disposable local runs with mock providers and libSQL. The browser retains one transient continuation record per active tab and releases the guide runtime and lock when it ends. JS heap usage was not profiled.
