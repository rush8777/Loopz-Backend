# Delivery identity policy

The legacy public manifest/experience-event parameter `trackedUserId` is an
**external customer user ID**, not the internal ID returned by the member API.
The parameter remains backward-compatible.

`resolveDeliveryUserId` is shared by ordinary experiences, checklists, shown
impressions and survey response ownership checks. Resolution is site-scoped:

1. If an external ID is explicitly supplied, resolve only that ID. An unknown
   or different external ID never falls back to a previous anonymous alias.
2. If no external ID is supplied, a known anonymous alias can restore its
   canonical internal tracked user. Alias and user must both belong to the site.
3. Without either, delivery uses the anonymous identity. Existing audience,
   origin, publication, scheduling, trigger, frequency and subscription checks
   remain authoritative; private audience definitions are not returned.

SDK reset/logout rotates anonymous and session IDs and removes the locally
identified user. An effective account switch also rotates these IDs. Therefore
an old alias does not identify the new logged-out or switched visitor. Integrators
must use SDK reset for logout rather than manually deleting only the external-ID
storage value: alias restoration deliberately supports returning visitors.

On first identification, unresolved analytics/experience/survey records under a
previously unclaimed anonymous ID can be claimed by the canonical user, matching
existing anonymous history and checklist merging. Already-owned records are not
reassigned, and repointing an alias from another account does not claim ambiguous
anonymous history. This preserves in-progress surveys and once-frequency across
an anonymous-to-identified promotion while maintaining account isolation.
