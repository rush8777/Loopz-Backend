# On-site builder API contract

## Persisted fields

Migration `0036_experience_builder_mode_revision.sql` adds:

- `experiences.builder_mode`, non-null with default `grapesjs`
- `experience_versions.revision`, non-null with default `1`

The builder mode is immutable after experience creation. Existing rows are backfilled by the SQLite default and remain dashboard-authored.

## Write ownership

Dashboard and SDK editor writes share the draft revision. Any definition or settings write must include the last observed `revision`; a stale value receives HTTP 409 and does not update the draft.

| Builder mode | Dashboard write | SDK editor-session write |
| --- | --- | --- |
| `grapesjs` | Full definition | Targeting and behavior only |
| `onsite` | Launch targeting only | Full definition |

Attempts to include `builderMode` in update payloads receive HTTP 409. The server also rejects unsupported on-site creation types, including surveys, checklists, and hotspots.

## Compatibility and deployment

Omitted builder mode still creates `grapesjs` experiences. Readers return `builderMode` and draft `revision` in list/detail and editor-draft responses.

Deploy in this order:

1. Apply the migration and deploy the backend.
2. Deploy SDK assets that understand `builderMode` and `revision`.
3. Deploy the dashboard creation and routing changes.

Published versions are unaffected by draft conflicts. Publishing remains explicit and preserves existing analytics, entitlement, ownership, targeting, and version behavior.

## Hardening follow-up (2026-10-16)

Dashboard and SDK saves share `src/lib/experiences/draftWrites.ts`. Both enforce subscription, entitlement additions, site ownership, valid references, schema/size, immutable builder ownership and draft-only atomic revision updates. Identical definitions keep the existing revision. On-site HTML/plain-text projections must match; empty/oversized fields return validation errors. SDK editor requests additionally validate session-to-experience-to-site ownership.

HTML validation uses parse5 so encoded protocols, duplicate/malformed attributes, invalid nesting and unsafe `_blank` links cannot bypass regular-expression checks. SDK/dashboard URL checks are mirrored. Install dependencies using the updated package-lock.json.

Publishing now **requires** `{ "draftVersionId": "<reviewed draft id>", "revision": <reviewed revision> }`. Missing payload returns 400 `reviewed_revision_required`. A changed draft or new draft version returns 409 `reviewed_draft_changed`. The check is repeated in the transactional publish update, preserving capacity/feature checks and immutable published versions. API clients must review again after a mismatch. Dashboard list actions now enter the editor/review workflow rather than publishing unseen drafts.

Migration 0036 is unchanged. No new migration, production data mutation, merge or deployment was performed. Focused regression tests pass (41/41); full backend has 479 pass, 7 existing unrelated failures and 22 skipped. The full implementation/QA report is in the SDK repository at `docs/onsite-builder-hardening.md` on the matching hardening branch. Real-browser verification remains pending because browser downloads were unavailable.

## Structured on-site documents (schema version 2)

New on-site Widgets and Guide steps are initialized with a strict cell document at `builder.projectData.movcues.onsiteDocument`. The outer `WidgetBuilderState.version` stays at `1` for transport compatibility; `projectData.movcues.schemaVersion` identifies the v2 authoring schema.

Every write is validated and deterministically recompiled server-side. The submitted `builder.html`, `builder.css`, structured `content`, and `projectData.movcues.actionBindings` must exactly match the compiler output. Draft writes reject inconsistent representations with the existing `inconsistent_onsite_content` response rather than accepting a tree with stale published output.

The v2 validator enforces exact object fields, one root cell, container-or-leaf semantics, unique IDs, no cycles or reused references, maximum depth 8, maximum 120 cells, 10,000-character rich-text blocks, 2,000-character image URLs, a 250 KB serialized document, safe rich-text/link/image protocols, controlled CSS values, and finite bounded dimensions. `next_step` and `previous_step` actions are valid only in Guides. Guide step IDs must be unique and labels are optional editor metadata capped at 80 characters.

For v2 only, compatibility heading/body fields may be empty because they are compiler projections of the actual block tree. Legacy on-site and GrapesJS content keeps the prior nonempty requirements. `builderMode` remains immutable and no GrapesJS project can be presented as a v2 on-site document.

New Widgets are created atomically with a valid initial v2 document and compiled output. No database migration is needed because the document remains inside the existing JSON definition.
