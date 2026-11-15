import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./helpers.js";
import { ContactEmailNotConfiguredError } from "../src/lib/contact.js";

describe("public contact", () => {
  const sendContactEmail = vi.fn(async () => undefined);
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ctx = await createTestApp({ sendContactEmail });
  });
  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  const valid = { name: "Taylor Guest", email: "taylor@example.com", message: "Can you help me with a product integration?", website: "" };
  const send = (payload: unknown, origin = "https://movcues.com") =>
    ctx.app.inject({ method: "POST", url: "/public/contact", headers: { origin }, payload });

  it("rejects missing and foreign origins", async () => {
    expect((await send(valid, "https://other.example")).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: "/public/contact", payload: valid })).statusCode).toBe(403);
    expect(sendContactEmail).not.toHaveBeenCalled();
  });

  it("validates contact fields", async () => {
    const response = await send({ ...valid, email: "invalid-email" });
    expect(response.statusCode).toBe(400);
    expect(sendContactEmail).not.toHaveBeenCalled();
  });

  it("ignores honeypot submissions", async () => {
    const response = await send({ ...valid, website: "https://spam.example" });
    expect(response.statusCode).toBe(200);
    expect(sendContactEmail).not.toHaveBeenCalled();
  });

  it("sends valid messages only and responds with a simple acknowledgement", async () => {
    const response = await send(valid);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(sendContactEmail).toHaveBeenCalledWith({
      name: valid.name, email: valid.email, message: valid.message,
    });
  });

  it("does not claim success if mail delivery fails", async () => {
    sendContactEmail.mockRejectedValueOnce(new Error("Email gateway failed"));
    const response = await send(valid);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "delivery_failed" });
  });

  it("reports missing configuration without leaking private settings", async () => {
    sendContactEmail.mockRejectedValueOnce(new ContactEmailNotConfiguredError());
    const response = await send(valid);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "contact_unavailable" });
  });
});
