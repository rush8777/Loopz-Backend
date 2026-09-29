import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = mocks.verifyIdToken;
  },
}));

import { verifyGoogleCredential } from "../src/lib/google-auth.js";

describe("Google credential verifier", () => {
  beforeEach(() => mocks.verifyIdToken.mockReset());

  it("passes the configured audience to Google's verifier and returns only verified claims", async () => {
    mocks.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "subject", email: "person@example.com", email_verified: true, name: "Person" }) });
    await expect(verifyGoogleCredential("credential", "configured-client-id")).resolves.toEqual({ subject: "subject", email: "person@example.com", name: "Person" });
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({ idToken: "credential", audience: "configured-client-id" });
  });

  it.each([
    { sub: "subject", email: "person@example.com", email_verified: false },
    { email: "person@example.com", email_verified: true },
    { sub: "subject", email_verified: true },
  ])("rejects unverified email or missing required identity claims", async (payload) => {
    mocks.verifyIdToken.mockResolvedValue({ getPayload: () => payload });
    await expect(verifyGoogleCredential("credential", "configured-client-id")).rejects.toThrow();
  });
});
