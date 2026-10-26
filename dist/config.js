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
    AI_ENABLED: z.string().trim().toLowerCase().default("false").transform((value) => value === "true"),
    AI_PROVIDER: z.enum(["vertex", "gemini", "openai"]).default("vertex"),
    AI_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(250_000),
    AI_MAX_CONTEXT_CHARS: z.coerce.number().int().min(10_000).max(250_000).default(60_000),
    VERTEX_PROJECT: z.string().trim().min(1).optional(),
    VERTEX_LOCATION: z.string().trim().min(1).default("us-central1"),
    VERTEX_MODEL: z.string().trim().min(1).default("gemini-2.5-flash"),
    GEMINI_API_KEY: z.string().trim().min(1).optional(),
    GEMINI_MODEL: z.string().trim().min(1).default("gemini-flash-lite-latest"),
    OPENAI_API_KEY: z.string().trim().min(1).optional(),
    OPENAI_MODEL: z.string().trim().min(1).default("gpt-5-mini"),
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
if (env.AI_ENABLED && env.AI_PROVIDER === "vertex" && !env.VERTEX_PROJECT) {
    throw new Error("VERTEX_PROJECT is required when AI_ENABLED=true and AI_PROVIDER=vertex.");
}
if (env.AI_ENABLED && env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required when AI_ENABLED=true and AI_PROVIDER=gemini.");
}
if (env.AI_ENABLED && env.AI_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when AI_ENABLED=true and AI_PROVIDER=openai.");
}
//# sourceMappingURL=config.js.map