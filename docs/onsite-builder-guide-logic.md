# Phase 8 Guide API contract

Branch: `codex/onsite-builder-guide-logic`, based on verified `be73f05ad810693dfe1a3231da48ef8613c4d2cc`.

Guide element-click/hover triggers accept optional `advance.target` (otherwise legacy `step.target` is used). Optional `presentation.delayMs` is integer 0..30000; `presentation.missingTarget` contains action wait/skip/dismiss and timeoutMs integer 100..60000. The runtime defaults are delay 0, discovery 5000 and hover 500 ms. No endpoint or database migration is required.

Schema validation rejects invalid durations, blank/control-character event names, incomplete route rules and unsupported Modal target settings. Publishing rejects missing positioning/interaction targets and a final-step skip with step-specific details. Drafts may retain a final-step skip while the next step is authored. Existing ID uniqueness, independent action references, immutable builder mode, entitlements and reviewed-revision publishing remain enforced.

35/35 focused contract/API tests pass. They cover actual on-site editor save/reload/publish, preservation of optional fields and legacy triggers, malformed configurations and HTTP rejection of final-step skip. Full suite: 499 passed, 7 baseline failures, 22 skipped. The same baseline failure names concern auth atomicity/concurrency, migrations, entitlements and tenant/usage. Production TypeScript build passes.

Full runtime behavior, cross-page contract, browser results, SDK bundle comparison and limits: [SDK report](https://github.com/rush8777/Loopz/blob/codex/onsite-builder-guide-logic/docs/onsite-builder-guide-logic.md).
