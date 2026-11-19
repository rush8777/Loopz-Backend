# Marketing contact form (movcues.com/contact)

The public Astro website submits to `POST https://api.movcues.com/public/contact` on the existing Fastify backend. The private recipient email is never embedded in the static website, API response, or GitHub source.

## One-time production configuration

1. In Resend, verify the domain `movcues.com` and add the DNS records it provides (SPF/DKIM). Use an address on that verified domain for sending, e.g. `Movcues <contact@movcues.com>`. An actual mailbox at that address is optional for sending; replies go to the visitor via Reply-To when you reply to the delivered email.
2. In Railway **backend** environment variables (not frontend/Cloudflare build vars), set:
   - `RESEND_API_KEY`: a secret Resend API key
   - `CONTACT_TO_EMAIL`: the private inbox that should receive requests
   - `CONTACT_FROM_EMAIL`: a verified sender, e.g. `Movcues <contact@movcues.com>`
3. Redeploy the backend. Keep the secret key and recipient out of GitHub and out of `PUBLIC_*` / `VITE_*` variables.
4. Deploy the website after merging the corresponding frontend contact-page branch. Confirm a test message arrives before announcing the page.

Local Astro development defaults to `https://api.movcues.com`; set `PUBLIC_API_URL=http://localhost:3000` to send to a local Fastify instance. Browser submissions from `http://localhost:4321` are permitted by the backend in non-production only.

## Security / behavior

Fields are validated server-side (name 2–120 chars, email, message 10–4000 chars); the website also validates fields. Requests require the expected Origin, include an invisible honeypot, are scoped to 5 requests per IP per 15 minutes, and never persist messages in Movcues analytics storage. Origins can be spoofed by non-browser bots; add Turnstile if spam becomes a problem. Provider delivery errors cause a visible form error (not a false success). The sender stays the verified Movcues domain; the visitor address is in Reply-To, not From.

Form data is transmitted to Resend and to the private inbox to handle the inquiry. Ensure the Privacy Policy describes this processing.
