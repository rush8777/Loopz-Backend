import type { FastifyInstance } from "fastify";
import { EventName } from "@paddle/paddle-node-sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { runInTransaction } from "../db/transaction.js";
import { billingWebhookEvents, organizationSubscriptions } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { PLAN_CATALOG, planDefinition, type PlanId } from "../lib/entitlements/plans.js";
import { getOrganizationSubscription, subscriptionIsActive, subscriptionPlanId } from "../lib/entitlements/subscription.js";
import { getOrganizationUsage } from "../lib/usage/usage.js";
import { env } from "../config.js";
import { paddleClient, paddleConfigured, paddlePriceId, planIdForPaddlePrice } from "../lib/billing/paddle.js";

function currentUtcMonth(now: Date) { return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }; }

export function registerBillingRoutes(app: FastifyInstance, db: Db) {
  app.get(
    "/orgs/:orgId/plan-usage",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const orgId = request.membership!.orgId; const now = new Date();
      const subscription = await getOrganizationSubscription(db, orgId, now);
      const plan = planDefinition(subscriptionPlanId(subscription));
      const usage = await getOrganizationUsage(db, orgId, currentUtcMonth(now), now);
      const mauPercent = plan.monthlyActiveUsers ? Math.round(usage.monthlyActiveUsers / plan.monthlyActiveUsers * 1000) / 10 : 0;
      return reply.send({
        subscription: {
          planId: plan.id, planName: plan.name, status: subscription.status,
          active: subscriptionIsActive(subscription),
          trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
          currentPeriodStartsAt: subscription.currentPeriodStartsAt?.toISOString() ?? null,
          currentPeriodEndsAt: subscription.currentPeriodEndsAt?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        },
        usage,
        limits: { ...plan.limits, monthlyActiveUsers: plan.monthlyActiveUsers },
        features: [...plan.features],
        billingConfigured: paddleConfigured(),
        monthlyActiveUsers: {
          current: usage.monthlyActiveUsers, limit: plan.monthlyActiveUsers, percent: mauPercent,
          state: mauPercent >= 100 ? "over_limit" : mauPercent >= 80 ? "warning" : "ok",
          softCap: true,
        },
      });
    },
  );

  app.get("/billing/plans", async (_request, reply) => reply.send({
    plans: Object.values(PLAN_CATALOG).map(plan => ({
      id: plan.id, name: plan.name, monthlyActiveUsers: plan.monthlyActiveUsers,
      limits: plan.limits, features: [...plan.features],
    })),
  }));

  app.post(
    "/orgs/:orgId/billing/checkout",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const parsed = z.object({ planId: z.enum(["starter", "growth", "scale"]) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const paddle = paddleClient(); const priceId = paddlePriceId(parsed.data.planId);
      if (!paddle || !priceId) return reply.code(503).send({ error: "billing_not_configured" });
      const existingSubscription = await getOrganizationSubscription(db, request.membership!.orgId);
      // A checkout creates a new Paddle subscription. Plan changes for an
      // existing paid subscription must go through the customer portal.
      if (existingSubscription.paddleSubscriptionId && subscriptionIsActive(existingSubscription)) {
        return reply.code(409).send({ error: "manage_subscription_in_portal" });
      }
      let transaction;
      try {
        transaction = await paddle.transactions.create({
          items: [{ priceId, quantity: 1 }],
          customData: { movcuesOrgId: request.membership!.orgId, movcuesPlanId: parsed.data.planId },
        });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (code === "transaction_default_checkout_url_not_set" || code === "transaction_checkout_url_domain_is_not_approved") {
          return reply.code(503).send({
            error: "billing_checkout_not_configured", code,
            message: "Checkout is not configured yet. Set the default payment link to your dashboard's /checkout page in Paddle → Checkout → Checkout configuration, using the same sandbox or live account as the backend. Live accounts require an approved domain.",
          });
        }
        throw error;
      }
      // The dashboard passes this transaction to Paddle.js, which opens an
      // overlay checkout on dash.movcues.com. Paddle still requires its account
      // default payment link; the secret API key is never sent to browsers.
      return reply.code(201).send({ transactionId: transaction.id });
    },
  );

  app.post(
    "/orgs/:orgId/billing/portal",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const subscription = await getOrganizationSubscription(db, request.membership!.orgId);
      const paddle = paddleClient();
      if (!paddle) return reply.code(503).send({ error: "billing_not_configured" });
      if (!subscription.paddleCustomerId || !subscription.paddleSubscriptionId) return reply.code(409).send({ error: "paid_subscription_not_found" });
      const session = await paddle.customerPortalSessions.create(subscription.paddleCustomerId, [subscription.paddleSubscriptionId]);
      return reply.send({ url: session.urls.general.overview });
    },
  );

  app.post(
    "/billing/paddle/webhook",
    { config: { rawBody: true } },
    async (request, reply) => {
      const paddle = paddleClient(); const signature = request.headers["paddle-signature"];
      if (!paddle || !env.PADDLE_WEBHOOK_SECRET) return reply.code(503).send({ error: "billing_not_configured" });
      if (typeof signature !== "string" || typeof request.rawBody !== "string") return reply.code(400).send({ error: "invalid_webhook" });
      let event;
      try { event = await paddle.webhooks.unmarshal(request.rawBody, env.PADDLE_WEBHOOK_SECRET, signature); }
      catch { return reply.code(400).send({ error: "invalid_signature" }); }

      const supported = new Set<string>([
        EventName.SubscriptionCreated, EventName.SubscriptionUpdated, EventName.SubscriptionActivated,
        EventName.SubscriptionPastDue, EventName.SubscriptionCanceled, EventName.SubscriptionPaused,
        EventName.SubscriptionResumed, EventName.SubscriptionTrialing,
      ]);
      if (!supported.has(event.eventType)) return reply.send({ received: true });
      const data = event.data as unknown as PaddleSubscriptionPayload;
      await syncPaddleSubscription(db, {
        eventId: event.eventId, eventType: event.eventType, occurredAt: new Date(event.occurredAt),
        subscription: data,
      });
      return reply.send({ received: true });
    },
  );
}

interface PaddleSubscriptionPayload {
  id: string; status: string; customerId: string; updatedAt: string;
  customData: Record<string, unknown> | null;
  currentBillingPeriod: { startsAt: string; endsAt: string } | null;
  scheduledChange: unknown;
  items: Array<{ price: { id: string } | null }>;
}

function internalStatus(status: string): "trialing" | "active" | "past_due" | "canceled" {
  if (status === "trialing") return "trialing";
  if (status === "active") return "active";
  if (status === "past_due") return "past_due";
  return "canceled";
}

export async function syncPaddleSubscription(
  db: Db,
  input: { eventId: string; eventType: string; occurredAt: Date; subscription: PaddleSubscriptionPayload },
  resolvePlan: (priceId: string | null | undefined) => PlanId | null = planIdForPaddlePrice,
) {
  await runInTransaction(db, async tx => {
    const [processed] = await tx.select({ eventId: billingWebhookEvents.eventId }).from(billingWebhookEvents).where(eq(billingWebhookEvents.eventId, input.eventId)).limit(1);
    if (processed) return;
    const orgIdFromData = typeof input.subscription.customData?.movcuesOrgId === "string" ? input.subscription.customData.movcuesOrgId : null;
    const byPaddleId = await tx.select().from(organizationSubscriptions).where(eq(organizationSubscriptions.paddleSubscriptionId, input.subscription.id)).limit(1);
    let subscription: typeof organizationSubscriptions.$inferSelect | undefined = byPaddleId[0];
    if (!subscription && orgIdFromData) {
      subscription = (await tx.select().from(organizationSubscriptions).where(eq(organizationSubscriptions.orgId, orgIdFromData)).limit(1))[0];
      if (subscription?.paddleSubscriptionId && subscription.paddleSubscriptionId !== input.subscription.id) subscription = undefined;
    }
    if (!subscription) {
      await tx.insert(billingWebhookEvents).values({ eventId: input.eventId, eventType: input.eventType, occurredAt: input.occurredAt });
      return;
    }
    if (subscription.paddleUpdatedAt && subscription.paddleUpdatedAt > input.occurredAt) {
      await tx.insert(billingWebhookEvents).values({ eventId: input.eventId, eventType: input.eventType, occurredAt: input.occurredAt });
      return;
    }
    const priceId = input.subscription.items.find(item => item.price)?.price?.id ?? null;
    const planId = resolvePlan(priceId);
    await tx.update(organizationSubscriptions).set({
      ...(planId ? { planId } : {}), status: internalStatus(input.subscription.status), trialEndsAt: null,
      currentPeriodStartsAt: input.subscription.currentBillingPeriod ? new Date(input.subscription.currentBillingPeriod.startsAt) : null,
      currentPeriodEndsAt: input.subscription.currentBillingPeriod ? new Date(input.subscription.currentBillingPeriod.endsAt) : null,
      paddleCustomerId: input.subscription.customerId, paddleSubscriptionId: input.subscription.id,
      paddlePriceId: priceId, paddleUpdatedAt: input.occurredAt,
      cancelAtPeriodEnd: Boolean(input.subscription.scheduledChange), updatedAt: new Date(),
    }).where(eq(organizationSubscriptions.id, subscription.id));
    await tx.insert(billingWebhookEvents).values({ eventId: input.eventId, eventType: input.eventType, occurredAt: input.occurredAt });
  });
}
