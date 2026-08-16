import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Tenant isolation depends on two chokepoints never being bypassed:
//   1. Tenant-scoped Prisma models (organization, user,
//      organizationMembership, customer, job, evidence, and the Phase 3
//      AI-assessment models) are only ever queried through
//      lib/db/repositories/*, which always run inside a tenant-scoped
//      transaction.
//   2. withTenantContext (the thing that actually sets the Postgres
//      session-local org/user context) is only ever called from
//      lib/auth/session.ts and lib/db/repositories/*, both of which are
//      responsible for verifying who's asking before they call it.
// See docs/architecture/security.md. These rules turn "always use the
// shared helper" from a convention into something CI enforces.
const tenantIsolationRules = [
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["lib/db/repositories/**", "prisma/**", "lib/generated/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // customer/job were missing here until Phase 2 -- the rule was
          // added in Phase 0 and never extended when Phase 1 introduced
          // those two tenant tables, so the chokepoint was documented but
          // unenforced for them. Backfilled along with evidence, and now
          // extended again for every Phase 3 AI-assessment model.
          selector:
            "MemberExpression[object.name='prisma'][property.name=/^(organization|user|organizationMembership|customer|job|evidence|aiAssessment|aiAssessmentInput|aiAssessmentFinding|aiAssessmentCitation|aiAssessmentTest|aiAssessmentQuestion|aiAssessmentSafetyWarning|technicianVerdict|aiUsageLedger)$/]",
          message:
            "Tenant-scoped Prisma models must only be accessed through lib/db/repositories/*. See lib/db/tenantContext.ts.",
        },
      ],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    // tests/security/** is a deliberate, narrow exception: those tests
    // are white-box checks of the tenant-context mechanism itself (e.g.
    // simulating a missing/forged context to prove RLS still holds), not
    // application code.
    ignores: [
      "lib/auth/**",
      "lib/db/repositories/**",
      "prisma/**",
      "tests/security/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/db/tenantContext",
              importNames: ["withTenantContext"],
              message:
                "withTenantContext must only be called from lib/auth/session.ts or lib/db/repositories/*, which are responsible for verifying the caller first. Use withAuthenticatedOrgContext (lib/auth/session.ts) instead.",
            },
          ],
        },
      ],
    },
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...tenantIsolationRules,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "lib/generated/**",
  ]),
]);

export default eslintConfig;
