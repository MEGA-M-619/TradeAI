import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    setupFiles: ["./tests/loadEnv.ts"],
    // tests/security/* make real network calls (Supabase Auth Admin API,
    // multi-statement DB transactions against a live Supabase project) --
    // Vitest's 5s default is comfortably enough for pure unit tests but
    // not reliably enough for those. Purely local/unit tests finish in
    // milliseconds either way, so a higher ceiling costs nothing there.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
});
