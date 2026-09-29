import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // libSQL is asynchronous and the auth suites intentionally exercise
    // bcrypt plus complete fresh-database migrations. Keep concurrency
    // bounded so Windows file-backed clients do not starve one another.
    maxWorkers: 4,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
