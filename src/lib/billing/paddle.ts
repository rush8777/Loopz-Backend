import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import { env } from "../../config.js";
import type { PlanId } from "../entitlements/plans.js";

let client: Paddle | null = null;

export function paddleClient(): Paddle | null {
  if (!env.PADDLE_API_KEY) return null;
  if (!client) client = new Paddle(env.PADDLE_API_KEY, { environment: env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox });
  return client;
}

export function paddlePriceId(planId: PlanId): string | null {
  return ({ starter: env.PADDLE_STARTER_PRICE_ID, growth: env.PADDLE_GROWTH_PRICE_ID, scale: env.PADDLE_SCALE_PRICE_ID })[planId] ?? null;
}

export function planIdForPaddlePrice(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === env.PADDLE_STARTER_PRICE_ID) return "starter";
  if (priceId === env.PADDLE_GROWTH_PRICE_ID) return "growth";
  if (priceId === env.PADDLE_SCALE_PRICE_ID) return "scale";
  return null;
}

export function paddleConfigured(): boolean {
  return Boolean(env.PADDLE_API_KEY && env.PADDLE_WEBHOOK_SECRET && env.PADDLE_STARTER_PRICE_ID && env.PADDLE_GROWTH_PRICE_ID && env.PADDLE_SCALE_PRICE_ID);
}
