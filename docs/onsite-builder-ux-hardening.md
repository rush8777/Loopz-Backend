# On-site builder integration hardening

Branch: `codex/onsite-builder-ux-hardening`, based on `7f77b5a6946dda7165cd2cd2d2817b38f29b4d1b` from `codex/onsite-builder-cell-composition`.

No backend runtime or schema change was needed. The new integration regression in `tests/experiences.test.ts` creates an on-site modal Guide, exchanges its editor token, splits and resizes a nested row, reorders content, adds a local raster image and an independent event action, duplicates a step with fresh IDs and a previous-step action, then verifies draft save/reload, stale-revision rejection, dashboard settings preservation and published content equality.

Validation: 26/26 focused experience/document/content-contract tests pass; production TypeScript build passes. Full suite: 484 passed, 7 failed, 22 skipped. The same seven failures were reproduced before changes in auth-atomicity, google-auth-multi-client, database-libsql, tenancy, usage and entitlements tests. No tests were disabled or weakened.

Immutable builder selection, atomic structured/compiled writes, bounded image validation and reviewed-revision publishing remain unchanged. This is integration coverage for the matching SDK UX hardening branch; no merge or deployment was performed. See the SDK's `docs/onsite-builder-ux-hardening.md` for browser coverage, sizes and remaining risks.
