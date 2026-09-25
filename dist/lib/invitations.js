import crypto from "node:crypto";
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
export function generateInvitationToken(now = Date.now()) {
    const token = crypto.randomBytes(32).toString("base64url");
    return {
        token,
        tokenHash: hashInvitationToken(token),
        expiresAt: new Date(now + INVITATION_TTL_MS),
    };
}
export function hashInvitationToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
export function getInvitationStatus(invitation, now = Date.now()) {
    if (invitation.acceptedAt)
        return "accepted";
    if (invitation.revokedAt)
        return "revoked";
    if (invitation.expiresAt.getTime() <= now)
        return "expired";
    return "pending";
}
export function invitationUrl(dashboardUrl, token) {
    return `${dashboardUrl.replace(/\/$/, "")}/invite/${encodeURIComponent(token)}`;
}
//# sourceMappingURL=invitations.js.map