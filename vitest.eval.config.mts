import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * A deliberately separate config from vitest.config.mts. The default
 * config's `include: ["tests/**\/*.test.ts"]` never matches anything
 * under tests/eval/ (files there end in `.eval.ts`), so `npm test`,
 * `npm run test:security`, and CI can never accidentally pull this in --
 * model quality is opt-in only, run by a human via `npm run
 * eval:assessment`, exactly as the approved Phase 3 plan requires.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/eval/**/*.eval.ts"],
    setupFiles: ["./tests/loadEnv.ts"],
    // Real vision model calls, potentially several per fixture case (the
    // model, then a JSON round trip) -- much longer than any other suite
    // needs.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
});
