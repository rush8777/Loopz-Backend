import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/config.js";
import { createTestApp } from "./helpers.js";

describe("CORS", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(() => ctx?.cleanup());

  it("allows configured and local development dashboard origins", async () => {
    const dashboardOrigin = new URL(env.DASHBOARD_URL).origin;
    const allowed = await ctx.app.inject({
      method: "OPTIONS",
      url: "/auth/google",
      headers: {
        origin: dashboardOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(dashboardOrigin);
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    const local = await ctx.app.inject({
      method: "OPTIONS",
      url: "/auth/google",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(local.statusCode).toBe(204);
    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(local.headers["access-control-allow-credentials"]).toBe("true");

    const rejected = await ctx.app.inject({
      method: "OPTIONS",
      url: "/auth/google",
      headers: { origin: "https://untrusted.example", "access-control-request-method": "POST" },
    });
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps public SDK endpoints cross-origin without credentials", async () => {
    const response = await ctx.app.inject({
      method: "OPTIONS",
      url: "/public/config/site_123",
      headers: { origin: "https://customer.example", "access-control-request-method": "GET" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://customer.example");
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
