import { env } from "../config.js";
export class ContactEmailNotConfiguredError extends Error {
    constructor() {
        super("Contact email delivery is not configured");
    }
}
/**
 * Sends contact requests from a verified Movcues sender. The visitor's email
 * is reply-to only: it never controls the From header or recipient address.
 */
export const sendContactEmail = async ({ name, email, message }) => {
    const { RESEND_API_KEY, CONTACT_TO_EMAIL, CONTACT_FROM_EMAIL } = env;
    if (!RESEND_API_KEY || !CONTACT_TO_EMAIL || !CONTACT_FROM_EMAIL) {
        throw new ContactEmailNotConfiguredError();
    }
    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from: CONTACT_FROM_EMAIL,
            to: [CONTACT_TO_EMAIL],
            reply_to: email,
            subject: "New Movcues contact request",
            text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
        }),
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        // The provider response may contain personal information: do not log it.
        throw new Error(`Contact email provider failed (status ${response.status})`);
    }
};
//# sourceMappingURL=contact.js.map