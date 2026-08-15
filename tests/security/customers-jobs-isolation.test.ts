import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  dbTestsEnabled,
  createAdminSupabaseClient,
  createPrivilegedPool,
} from "./helpers";
import { prisma } from "@/lib/db/prisma";
import { withTenantContext } from "@/lib/db/tenantContext";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { userRepository } from "@/lib/db/repositories/userRepository";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";

// Phase 1 extension of the Phase 0 tenant-isolation suite: same threat
// model (cross-org access, forged context), applied to the two new
// tenant tables. Requires a live Supabase project. Skipped by default.
describe.skipIf(!dbTestsEnabled)("customers/jobs tenant isolation", () => {
  // Constructed in beforeAll, not here: describe.skipIf still evaluates
  // this describe body (only the `it`s are skipped), so anything that
  // reads env vars eagerly must not run at this scope.
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  let privileged: ReturnType<typeof createPrivilegedPool>;

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let orgA: { id: string };
  let orgB: { id: string };
  let customerA: { id: string };
  let jobA: { id: string };

  beforeAll(async () => {
    admin = createAdminSupabaseClient();
    privileged = createPrivilegedPool();

    const emailA = `tradeai-cj-test-a-${randomUUID()}@example.invalid`;
    const emailB = `tradeai-cj-test-b-${randomUUID()}@example.invalid`;

    const { data: createdA, error: errA } = await admin.auth.admin.createUser({
      email: emailA,
      email_confirm: true,
    });
    if (errA || !createdA.user) throw errA ?? new Error("user A create failed");
    const { data: createdB, error: errB } = await admin.auth.admin.createUser({
      email: emailB,
      email_confirm: true,
    });
    if (errB || !createdB.user) throw errB ?? new Error("user B create failed");

    userA = { id: createdA.user.id, email: emailA };
    userB = { id: createdB.user.id, email: emailB };

    await userRepository.ensureProfile(userA.id, userA.email);
    await userRepository.ensureProfile(userB.id, userB.email);

    orgA = await organizationRepository.create(userA.id, "CJ Test Org A");
    orgB = await organizationRepository.create(userB.id, "CJ Test Org B");

    customerA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        customerRepository.create(tx, orgA.id, { name: "Alice Homeowner" }),
    );
    jobA = await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      jobRepository.create(tx, orgA.id, userA.id, {
        customerId: customerA.id,
        title: "No power to kitchen outlets",
      }),
    );
  });

  afterAll(async () => {
    // Guarded throughout: a beforeAll failure partway through shouldn't
    // surface as a second, confusing cleanup error on top of the real one.
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
    if (privileged && orgIds.length > 0) {
      await privileged.query(
        `delete from public.jobs where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.customers where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.organization_memberships where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.organizations where id = any($1::uuid[])`,
        [orgIds],
      );
    }
    if (admin && userA) await admin.auth.admin.deleteUser(userA.id);
    if (admin && userB) await admin.auth.admin.deleteUser(userB.id);
    await privileged?.end();
    await prisma.$disconnect();
  });

  it("same-org access: the owning org can read its own customer and job", async () => {
    const customer = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => customerRepository.getById(tx, orgA.id, customerA.id),
    );
    expect(customer?.id).toBe(customerA.id);

    const job = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => jobRepository.getById(tx, orgA.id, jobA.id),
    );
    expect(job?.id).toBe(jobA.id);
  });

  it("cross-org access: org B cannot read org A's customer or job via its own (legitimate) context", async () => {
    const customer = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => customerRepository.getById(tx, orgB.id, customerA.id),
    );
    expect(customer).toBeNull();

    const job = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => jobRepository.getById(tx, orgB.id, jobA.id),
    );
    expect(job).toBeNull();
  });

  it("forged context: userB with app.current_org_id forced to orgA still sees nothing (is_member_of re-derivation)", async () => {
    // Simulates the same class of app-layer bug Test 6 in
    // tenant-isolation.test.ts covers for organizations: org context set
    // without having gone through resolveOrgContext for this user.
    const customer = await withTenantContext(
      { userId: userB.id, orgId: orgA.id },
      (tx) => customerRepository.getById(tx, orgA.id, customerA.id),
    );
    expect(customer).toBeNull();
  });

  it("listing is scoped per org: org B's customer list never includes org A's customers", async () => {
    const customerB = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => customerRepository.create(tx, orgB.id, { name: "Bob Renter" }),
    );

    const listForB = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => customerRepository.listForOrg(tx, orgB.id),
    );
    expect(listForB.map((c) => c.id)).toContain(customerB.id);
    expect(listForB.map((c) => c.id)).not.toContain(customerA.id);
  });

  it("a cross-org write is rejected (record not found), not silently applied", async () => {
    await expect(
      withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
        customerRepository.update(tx, orgB.id, customerA.id, {
          name: "renamed by the wrong org",
        }),
      ),
    ).rejects.toThrow();

    // Confirm it genuinely wasn't applied.
    const stillOriginal = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => customerRepository.getById(tx, orgA.id, customerA.id),
    );
    expect(stillOriginal?.name).toBe("Alice Homeowner");
  });
});
