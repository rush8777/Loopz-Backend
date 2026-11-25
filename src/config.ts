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
  RESEND_API_KEY: z.string().trim().min(1).optional(),
  CONTACT_TO_EMAIL: z.string().trim().email().optional(),
  CONTACT_FROM_EMAIL: z.string().trim().min(1).optional(),
  PADDLE_API_KEY: z.string().trim().min(1).optional(),
  PADDLE_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
  PADDLE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  PADDLE_STARTER_PRICE_ID: z.string().trim().min(1).optional(),
  PADDLE_GROWTH_PRICE_ID: z.string().trim().min(1).optional(),
  PADDLE_SCALE_PRICE_ID: z.string().trim().min(1).optional(),
  GUIDE_CAPTURE_ENABLED: z.string().trim().toLowerCase().default("false").transform(value => value === "true"),
  KNOWLEDGE_WORKER_ENABLED: z.string().trim().toLowerCase().default("false").transform(value => value === "true"),
  KNOWLEDGE_FILE_MAX_BYTES: z.coerce.number().int().positive().max(5_000_000).default(3_000_000),
  KNOWLEDGE_EMBEDDING_MODEL: z.enum(["text-embedding-3-small", "text-embedding-3-large"]).default("text-embedding-3-small"),
  KNOWLEDGE_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(1536).default(512),
  KNOWLEDGE_EMBEDDING_VERSION: z.string().min(1).max(30).default("1"),
  KNOWLEDGE_CHUNK_WORDS: z.coerce.number().int().min(80).max(600).default(360),
  KNOWLEDGE_CHUNK_OVERLAP: z.coerce.number().int().min(0).max(79).default(40),
  GEO_AGENT_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(24000).default(250000),
  GEO_AGENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  AI_ENABLED: z.string().trim().toLowerCase().default("false").transform((value) => value === "true"),
  AI_PROVIDER: z.enum(["vertex", "gemini", "openai"]).default("vertex"),
  AI_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(250_000),
  AI_MAX_CONTEXT_CHARS: z.coerce.number().int().min(10_000).max(250_000).default(60_000),
  EDITOR_AI_DEADLINE_MS: z.coerce.number().int().min(10_000).max(180_000).default(90_000),
  VERTEX_PROJECT: z.string().trim().min(1).optional(),
  VERTEX_LOCATION: z.string().trim().min(1).default("us-central1"),
  VERTEX_MODEL: z.string().trim().min(1).default("gemini-2.5-flash"),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_MODEL: z.string().trim().min(1).default("gemini-flash-lite-latest"),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-5-mini"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).default("none"),
});

export const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production" && (
  env.JWT_SECRET === "dev-only-insecure-secret-change-me"
  || env.JWT_SECRET.startsWith("replace-with-")
  || env.JWT_SECRET.length < 32
)) {
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
