import { OAuth2Client } from "google-auth-library";
const client = new OAuth2Client();
/** Verify all token security properties through Google's supported verifier. */
export const verifyGoogleCredential = async (credential, clientId) => {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
        throw new Error("invalid Google identity claims");
    }
    return {
        subject: payload.sub,
        email: payload.email,
        ...(payload.name ? { name: payload.name } : {}),
    };
};
//# sourceMappingURL=google-auth.js.map