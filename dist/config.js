import "dotenv/config";
import { z } from "zod";
const envSchema = z.object({
    DATABASE_URL: z.string().min(1).default("file:./dev.db"),
    DATABASE_AUTH_TOKEN: z.string().trim().min(1).optional(),
    JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters").default("dev-only-insecure-secret-change-me"),
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DASHBOARD_URL: z.string().url().default("http://localhost:5173"),
    GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
    PADDLE_API_KEY: z.string().trim().min(1).optional(),
    PADDLE_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
    PADDLE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    PADDLE_STARTER_PRICE_ID: z.string().trim().min(1).optional(),
    PADDLE_GROWTH_PRICE_ID: z.string().trim().min(1).optional(),
    PADDLE_SCALE_PRICE_ID: z.string().trim().min(1).optional(),
});
export const env = envSchema.parse(process.env);
if (env.NODE_ENV === "production" && (env.JWT_SECRET === "dev-only-insecure-secret-change-me"
    || env.JWT_SECRET.startsWith("replace-with-")
    || env.JWT_SECRET.length < 32)) {
    throw new Error("JWT_SECRET must be a non-placeholder value of at least 32 characters in production.");
}
if (env.NODE_ENV === "production" && env.DATABASE_URL.startsWith("libsql://") && !env.DATABASE_AUTH_TOKEN) {
    throw new Error("DATABASE_AUTH_TOKEN is required for a remote libSQL database in production.");
}
//# sourceMappingURL=config.js.map