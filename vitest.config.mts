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
    // Test files run one at a time. Every tests/security/* file opens its
    // own privileged pg pool and its own Prisma transactions against the
    // same live Supabase project, and Test 7 in tenant-isolation
    // deliberately fires 20 concurrent transactions to prove context can't
    // leak across pooled connections. Running those files in parallel
    // manufactures pool exhaustion ("Unable to start a transaction in the
    // given time") that is purely an artifact of the runner, not of
    // anything under test -- it began failing ~2 runs in 3 once Phase 2
    // added two more live-DB files. Serialising costs a few seconds and
    // weakens no assertion.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
});
