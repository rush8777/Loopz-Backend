import type { FastifyReply } from "fastify";
import { EntitlementDeniedError } from "./service.js";

export function sendEntitlementError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof EntitlementDeniedError)) throw error;
  return reply.code(error.decision.reason === "subscription_inactive" ? 402 : 403).send({
    error: error.decision.reason,
    entitlement: error.decision,
  });
}
