import { z } from "zod";
export const guidanceAction = z.object({
    type: z.literal("start_guide"),
    actionId: z.uuid(),
    label: z.literal("Guide me"),
    expiresAt: z.number().int().positive(),
}).strict();
export const recommendationDurationMs = 5 * 60_000;
export const guidanceDurationMs = 30 * 60_000;
export const liveGuidanceStates = ["accepted", "started", "waiting"];
const instanceId = z.uuid();
export const acceptGuidance = z.object({ actionId: z.uuid(), instanceId, identityToken: z.string().max(4000).optional() }).strict();
export const guidanceClaim = z.object({ instanceId, identityToken: z.string().max(4000).optional(), operation: z.enum(["launch", "restore", "check"]) }).strict();
export const guidanceEvent = z.object({
    instanceId,
    sequence: z.number().int().min(1).max(2048),
    type: z.enum(["visible", "waiting", "advanced", "completed", "cancelled", "failed"]),
    stepId: z.string().min(1).max(64).optional(),
    failure: z.enum(["missing_target", "runtime"]).optional(),
}).strict().refine(event => (event.type === "failed") === !!event.failure, "Expected a failure reason only for a failed guide");
//# sourceMappingURL=guidanceContract.js.map