import { verifyAccessToken } from "../lib/auth.js";
import { env } from "../config.js";
export async function authenticate(request, reply) {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "missing_authorization" });
    }
    const token = header.slice("Bearer ".length);
    try {
        const payload = verifyAccessToken(token, env.JWT_SECRET);
        request.user = { id: payload.sub, email: payload.email };
    }
    catch {
        return reply.code(401).send({ error: "invalid_or_expired_token" });
    }
}
//# sourceMappingURL=authenticate.js.map