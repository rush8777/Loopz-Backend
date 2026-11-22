import { z } from "zod";
import { env } from "../config.js";
import { ContactEmailNotConfiguredError } from "../lib/contact.js";
const contactSchema = z.strictObject({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254),
    message: z.string().trim().min(10).max(4000),
    website: z.string().max(200).optional().default(""), // Honeypot, must stay empty.
});
export function registerPublicContactRoutes(app, sendEmail) {
    app.post("/public/contact", { bodyLimit: 12_000 }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const allowedOrigins = new Set(["https://movcues.com", "https://www.movcues.com"]);
        if (env.NODE_ENV !== "production") {
            allowedOrigins.add("http://localhost:4321");
            allowedOrigins.add("http://127.0.0.1:4321");
        }
        // Browser guard, not a substitute for rate limits: non-browser clients can
        // spoof Origin. Do not permit submissions from unrelated websites.
        if (!request.headers.origin || !allowedOrigins.has(request.headers.origin)) {
            return reply.code(403).send({ error: "origin_not_allowed" });
        }
        const parsed = contactSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_contact_fields" });
        }
        if (parsed.data.website) {
            // Silent honeypot. Do not send or store spam messages.
            return reply.send({ ok: true });
        }
        try {
            await sendEmail({
                name: parsed.data.name,
                email: parsed.data.email,
                message: parsed.data.message,
            });
            return reply.send({ ok: true });
        }
        catch (error) {
            if (error instanceof ContactEmailNotConfiguredError) {
                return reply.code(503).send({ error: "contact_unavailable" });
            }
            // No sender address, message body, or provider response in logs.
            request.log.error("Contact delivery failed");
            return reply.code(502).send({ error: "delivery_failed" });
        }
    });
}
//# sourceMappingURL=public-contact.js.map