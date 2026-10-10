import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, signup } from "./helpers.js";

// Real application routes and a disposable local database;
// Paddle is mocked so no payment, transaction, or customer is created remotely.
const provider = vi.hoisted(() => ({ create: vi.fn(), available: true }));
vi.mock("../src/lib/billing/paddle.js", () => ({
  paddleClient: () => provider.available ? { transactions: { create: provider.create } } : null,
  paddlePriceId: (plan: string) => `pri_test_${plan}`,
  paddleConfigured: () => provider.available,
  planIdForPaddlePrice: () => null,
}));

describe("Paddle checkout", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let authorization: string;
  beforeEach(async () => {
    provider.available = true;
    provider.create.mockReset();
    ctx = await createTestApp();
    const owner = await signup(ctx.app);
    orgId = owner.org.id;
    authorization = `Bearer ${owner.accessToken}`;
  });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });
  const checkout = () => ctx.app.inject({
    method: "POST", url: `/orgs/${orgId}/billing/checkout`,
    headers: { authorization }, payload: { planId: "starter" },
  });

  it("returns the transaction ID when Paddle accepts the request", async () => {
    provider.create.mockResolvedValue({ id: "txn_test_diagnostic" });
    const response = await checkout();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ transactionId: "txn_test_diagnostic" });
    expect(provider.create).toHaveBeenCalledWith({
      items: [{ priceId: "pri_test_starter", quantity: 1 }],
      customData: { movcuesOrgId: orgId, movcuesPlanId: "starter" },
    });
  });

  it.each(["transaction_default_checkout_url_not_set", "transaction_checkout_url_domain_is_not_approved"])("reports an actionable configuration error for %s", async (code) => {
    const message = "Cannot create a transaction or open a checkout as no default payment link has been set for this account. Set in the Paddle dashboard, then try again.";
    provider.create.mockRejectedValue(Object.assign(new Error(message), {
      code,
    }));
    const response = await checkout();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "billing_checkout_not_configured", code });
    expect(response.json().message).toContain("/checkout");
  });

  it("returns 503 without calling Paddle when billing has no configured client", async () => {
    provider.available = false;
    const response = await checkout();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "billing_not_configured" });
    expect(provider.create).not.toHaveBeenCalled();
  });
});
