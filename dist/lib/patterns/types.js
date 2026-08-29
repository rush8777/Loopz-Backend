/**
 * Shared pattern schema. Both human-authored patterns (built through the
 * authoring UI) and ML-discovered patterns (found via batch mining,
 * later promoted through human review) compile into this exact shape.
 * The live matcher below never knows or cares which origin produced a
 * given pattern - that's the whole point of having one shared format.
 *
 * Target matching is selector-based for this pass (matches
 * ElementDescriptor.selector from the SDK's event payloads). The
 * conceptually "correct" version uses structural fingerprints (role +
 * region + size-bucket) so patterns survive a site redesign - that
 * fingerprinting layer doesn't exist in the SDK yet, so selector match
 * is the honest, buildable-today substitute. Swapping the matching
 * strategy later only touches `matchesTarget()` below, not the FSM.
 */
export {};
//# sourceMappingURL=types.js.map