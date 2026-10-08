import { eq, and } from "drizzle-orm";
import { memberships } from "../db/schema.js";
import { hasAtLeastRole, isValidRole } from "../lib/roles.js";
import { getOrganizationSubscription, subscriptionIsActive } from "../lib/entitlements/subscription.js";
/**
 * Enforces that the authenticated user belongs to the org named by
 * `:orgId` in the route params, with at least `minRole`. This is the
 * single choke point tenant isolation flows through for every
 * org-scoped route - every handler that touches org data should sit
 * behind this rather than re-deriving org membership itself.
 */
export function requireOrgRole(db, minRole) {
    return async function (request, reply) {
        const orgId = request.params.orgId;
        if (!request.user) {
            // Should be unreachable if `authenticate` ran first, but never trust that silently.
            return reply.code(401).send({ error: "missing_authorization" });
        }
        if (!orgId) {
            return reply.code(400).send({ error: "missing_org_id" });
        }
        const [row] = await db
            .select()
            .from(memberships)
            .where(and(eq(memberships.userId, request.user.id), eq(memberships.orgId, orgId)))
            .limit(1);
        // Deliberately the same 404 whether the org doesn't exist or the
        // user just isn't a member of it - a 403 here would leak which org
        // IDs are valid to anyone who guesses one.
        if (!row || !isValidRole(row.role)) {
            return reply.code(404).send({ error: "org_not_found" });
        }
        if (!hasAtLeastRole(row.role, minRole)) {
            return reply.code(403).send({ error: "insufficient_role", required: minRole, actual: row.role });
        }
        const billingRecovery = request.url.includes("/billing/checkout") || request.url.includes("/billing/portal");
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !billingRecovery) {
            const subscription = await getOrganizationSubscription(db, orgId);
            if (!subscriptionIsActive(subscription)) {
                return reply.code(402).send({
                    error: "subscription_inactive",
                    entitlement: {
                        allowed: false,
                        reason: "subscription_inactive",
                        planId: subscription.planId,
                        trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
                        upgradeRequired: true,
                    },
                });
            }
        }
        request.membership = { orgId, role: row.role };
    };
}
//# sourceMappingURL=requireOrgRole.js.map