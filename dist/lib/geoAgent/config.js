import { createPublicKey } from "node:crypto";
import { z } from "zod";
const publicImage = z.url().max(2000).refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
}, "Use an HTTPS image URL");
export const geoAgentAppearance = z.object({
    name: z.string().trim().min(1).max(60).default("Geo Agent"),
    avatarUrl: publicImage.optional(),
    brandColor: z.string().regex(/^#[0-9a-f]{6}$/i).default("#2563eb"),
    theme: z.enum(["light", "dark", "system"]).default("system"),
    launcher: z.enum(["icon", "label"]).default("icon"),
    launcherLabel: z.string().trim().min(1).max(35).default("Ask Geo"),
    position: z.enum(["bottom-left", "bottom-right"]).default("bottom-right"),
    welcome: z.string().trim().min(1).max(500).default("Hi! How can I help?"),
    placeholder: z.string().trim().min(1).max(80).default("Ask a question…"),
    suggestions: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
}).strict();
export const geoAgentConfig = z.object({
    schemaVersion: z.literal(1),
    appearance: geoAgentAppearance,
    enabled: z.boolean().default(true),
    showLauncher: z.boolean().default(true),
    persistence: z.enum(["page", "tab"]).default("tab"),
    sourceIds: z.array(z.string().min(1).max(64)).max(30).default([]).transform(ids => [...new Set(ids)]),
    instructions: z.string().trim().max(1500).default(""),
    fallback: z.string().trim().min(1).max(350).default("I couldn’t find an answer in the available help content."),
    identityPublicKey: z.string().trim().max(512).refine(value => {
        if (!value.startsWith("-----BEGIN PUBLIC KEY-----"))
            return false;
        try {
            return createPublicKey(value).asymmetricKeyType === "ed25519";
        }
        catch {
            return false;
        }
    }, "Enter an Ed25519 public key").optional(),
}).strict();
export function deliveryConfig(config) {
    return { schemaVersion: config.schemaVersion, appearance: config.appearance, persistence: config.persistence };
}
//# sourceMappingURL=config.js.map