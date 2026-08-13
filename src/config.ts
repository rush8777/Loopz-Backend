import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default("./dev.db"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters").default("dev-only-insecure-secret-change-me"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production" && env.JWT_SECRET === "dev-only-insecure-secret-change-me") {
  throw new Error("JWT_SECRET must be set explicitly in production - refusing to start with the dev default.");
}
