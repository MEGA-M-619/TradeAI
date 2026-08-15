// Next.js conventionally keeps local secrets in .env.local; load that
// (falling back to .env) so `prisma migrate`/`prisma generate` see the
// same values the app does.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { defineConfig, env } from "prisma/config";

// IMPORTANT — this file is a Prisma CLI concern only (migrate/generate/
// studio). It has no effect on the running application: app runtime code
// (lib/db/prisma.ts) builds its own PrismaPg adapter directly from
// process.env.DATABASE_URL and never reads this file.
//
// Prisma 7.9's `datasource` config has no `directUrl` field (verified
// against node_modules/@prisma/config/dist/index.d.ts — the field was
// removed, despite some v6-era docs still mentioning it). So the
// runtime/migration connection split is expressed differently here:
// this file's datasource.url is DIRECT_URL (the privileged, non-pooled
// Supabase `postgres` connection), because the *only* thing this config
// is used for is running migrations. The pooled, least-privilege
// `app_user` connection (DATABASE_URL) is deliberately never referenced
// from here — see docs/architecture/security.md for why the two must
// stay separate.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});
