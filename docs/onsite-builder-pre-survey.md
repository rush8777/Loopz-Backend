# Phase 8.5 backend stabilization

Baseline `codex/onsite-builder-guide-logic` at `dcbb220`; feature branch `codex/onsite-builder-pre-survey`. No production behavior or schema change, merge or deployment.

All seven baseline failures were stale expectations or fixtures after account creation and workspace onboarding became separate operations:

- Password/Google atomicity now inject session insertion failures during account creation. Four additional onboarding failure-and-retry cases verify rollback at organization, membership, subscription and site writes without deleting the account/session.
- Independent database clients authenticate concurrently into one canonical account, then race onboarding and verify exactly one organization/membership/site/subscription (201/409).
- Migration count follows the checked-in journal, reapplication is idempotent, and the experience revision column is checked.
- Starter capacity, tenancy and usage fixtures account for the mandatory onboarding site, retaining and strengthening limit and cross-tenant assertions.

Verification: 510 tests pass, 22 existing skips remain in legacy disabled route suites; production build passes. No tests were removed or newly skipped.

`tests/fixtures/builder-integration-server.ts` supports the SDK's actual-service Playwright suite. It requires `NODE_ENV=test`, creates its own temporary migrated database independently of production configuration, binds `127.0.0.1:4310`, exposes test-only inspection/expiration routes, and removes its database on graceful shutdown. It is not imported by the production server.

Shared browser/integration results and bundle measurements are in SDK `docs/onsite-builder-pre-survey.md`. SDK `docs/phase-9-survey-handoff.md` reviews reuse of existing Survey response validation, persistence and analytics and documents response-save/recovery gates before Phase 9. No Survey authoring or runtime rewrite is included.
