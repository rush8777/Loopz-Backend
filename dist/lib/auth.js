import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
const BCRYPT_ROUNDS = 12;
export async function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
export async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export function signAccessToken(payload, secret) {
    return jwt.sign(payload, secret, { expiresIn: ACCESS_TOKEN_TTL });
}
export function verifyAccessToken(token, secret) {
    return jwt.verify(token, secret);
}
/**
 * Refresh tokens are opaque random strings, not JWTs - the server is the
 * only party that ever needs to validate them, so there's no benefit to
 * a self-describing token, and an opaque one is trivially revocable
 * (JWTs are not, without an extra denylist that defeats the point of
 * using a JWT in the first place).
 */
export function generateRefreshToken() {
    const token = crypto.randomBytes(32).toString("base64url");
    return {
        token,
        hash: hashRefreshToken(token),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    };
}
/** Refresh tokens are stored hashed - a DB read alone can't be used to mint a session. */
export function hashRefreshToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
export function signEditorAccessToken(payload, secret) {
    return jwt.sign(payload, secret, { expiresIn: "10m" });
}
export function verifyEditorAccessToken(token, secret) {
    const payload = jwt.verify(token, secret);
    if (payload.scope !== "experience_editor")
        throw new Error("invalid editor scope");
    return payload;
}
//# sourceMappingURL=auth.js.map