// Vitest, unlike Next.js, does not auto-load .env.local. Loaded via
// vitest.config.mts's `setupFiles` so tests see the same environment
// variables the running app would.
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });
