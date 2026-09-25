import crypto from "node:crypto";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationRole = "ADMIN" | "MEMBER" | "VIEWER";
export type InvitationStatus = "pending" | "expired" | "revoked" | "accepted";

export function normalizeEmail(email: string): string {
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

export function hashInvitationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function getInvitationStatus(invitation: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}, now = Date.now()): InvitationStatus {
  if (invitation.acceptedAt) return "accepted";
  if (invitation.revokedAt) return "revoked";
  if (invitation.expiresAt.getTime() <= now) return "expired";
  return "pending";
}

export function invitationUrl(dashboardUrl: string, token: string): string {
  return `${dashboardUrl.replace(/\/$/, "")}/invite/${encodeURIComponent(token)}`;
}
