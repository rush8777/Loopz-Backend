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
