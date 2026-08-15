import { PrismaClient } from "@/lib/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Deliberately independent of prisma.config.ts (which is a CLI-only
// concern for migrations). This is the actual runtime connection, and it
// must always authenticate as the least-privilege `app_user` role via the
// pooled DATABASE_URL -- never the migration role. See
// docs/architecture/security.md.
function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

declare global {
  var __prisma: PrismaClient | undefined;
}

function getPrismaClient(): PrismaClient {
  // Reuse a single instance across Next.js dev-server hot reloads (and
  // across repeated imports generally) so we don't exhaust the
  // connection pool.
  globalThis.__prisma ??= createPrismaClient();
  return globalThis.__prisma;
}

// Lazy: constructing the real client (and validating DATABASE_URL) only
// happens on first actual use, not on module import. Importing this
// module must never throw just because DATABASE_URL isn't set yet --
// e.g. during typecheck/build tooling, or in test files that import it
// but skip every test that would use it.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getPrismaClient() as object, prop, receiver);
  },
});
