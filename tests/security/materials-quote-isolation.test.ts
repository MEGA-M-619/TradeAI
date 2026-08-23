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
import { materialRepository } from "@/lib/db/repositories/materialRepository";
import {
  quoteRepository,
  QuoteAlreadyExistsError,
} from "@/lib/db/repositories/quoteRepository";

// MVP-audit extension of the customers/jobs tenant-isolation suite (same
// threat model: cross-org access, cross-org write), applied to the two
// newest tenant tables -- Materials and Quote/QuoteLineItem had zero test
// coverage before this file, despite being the only tables in the schema
// that carry money. Requires a live Supabase project. Skipped by default.
describe.skipIf(!dbTestsEnabled)("materials/quote tenant isolation and money math", () => {
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

    const emailA = `tradeai-mq-test-a-${randomUUID()}@example.invalid`;
    const emailB = `tradeai-mq-test-b-${randomUUID()}@example.invalid`;

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

    orgA = await organizationRepository.create(userA.id, "MQ Test Org A");
    orgB = await organizationRepository.create(userB.id, "MQ Test Org B");

    customerA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => customerRepository.create(tx, orgA.id, { name: "Alice Homeowner" }),
    );
    jobA = await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      jobRepository.create(tx, orgA.id, userA.id, {
        customerId: customerA.id,
        title: "Panel upgrade",
      }),
    );
  });

  afterAll(async () => {
    // Deleting the job cascades to materials/quotes/quote_line_items
    // (all ON DELETE CASCADE from job_id/quote_id) -- no separate cleanup
    // needed for the new tables.
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

  it("same-org access: the owning org can read its own material", async () => {
    const material = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        materialRepository.create(tx, orgA.id, jobA.id, userA.id, {
          description: "200A panel",
          quantity: 1,
          unitCostCents: 45000,
        }),
    );

    const found = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => materialRepository.getById(tx, orgA.id, jobA.id, material.id),
    );
    expect(found?.id).toBe(material.id);
  });

  it("cross-org access: org B cannot read org A's materials via its own (legitimate) context", async () => {
    const materials = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => materialRepository.listForJob(tx, orgA.id, jobA.id),
    );
    expect(materials.length).toBeGreaterThan(0);
    const materialId = materials[0].id;

    const crossOrgRead = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => materialRepository.getById(tx, orgB.id, jobA.id, materialId),
    );
    expect(crossOrgRead).toBeNull();

    const crossOrgList = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => materialRepository.listForJob(tx, orgB.id, jobA.id),
    );
    expect(crossOrgList).toHaveLength(0);
  });

  it("a cross-org material write is rejected (record not found), not silently applied", async () => {
    const materials = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => materialRepository.listForJob(tx, orgA.id, jobA.id),
    );
    const materialId = materials[0].id;

    await expect(
      withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
        materialRepository.update(tx, orgB.id, jobA.id, materialId, {
          description: "renamed by the wrong org",
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
        materialRepository.remove(tx, orgB.id, jobA.id, materialId),
      ),
    ).rejects.toThrow();

    const stillThere = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => materialRepository.getById(tx, orgA.id, jobA.id, materialId),
    );
    expect(stillThere?.description).toBe("200A panel");
  });

  it("quote money math: line totals are rounded once server-side and the subtotal is an exact integer sum (no float drift)", async () => {
    // 2.5 * 333 = 832.5 -- deliberately non-integer, to exercise the
    // single rounding point in quoteRepository.computeLineTotalCents
    // rather than an input that would round-trip cleanly by accident.
    const quote = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        quoteRepository.create(tx, orgA.id, jobA.id, userA.id, [
          {
            kind: "material",
            description: "12 AWG wire",
            quantity: 2.5,
            unitPriceCents: 333,
          },
          {
            kind: "labor",
            description: "Panel swap",
            quantity: 3,
            unitPriceCents: 15000,
          },
        ]),
    );

    const wireLineItem = quote.lineItems.find((li) => li.description === "12 AWG wire");
    expect(wireLineItem?.lineTotalCents).toBe(833); // Math.round(832.5) = 833
    const laborLineItem = quote.lineItems.find((li) => li.description === "Panel swap");
    expect(laborLineItem?.lineTotalCents).toBe(45000);

    // Every value here is an integer at rest -- no float ever represents
    // money in the persisted row.
    expect(Number.isInteger(quote.subtotalCents)).toBe(true);
    expect(quote.subtotalCents).toBe(833 + 45000);
    // No tax/discount exists yet -- total is a real, separately-computed
    // column that happens to equal subtotal today.
    expect(quote.totalCents).toBe(quote.subtotalCents);
  });

  it("generating a second quote for the same job is refused, not silently overwritten", async () => {
    await expect(
      withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
        quoteRepository.create(tx, orgA.id, jobA.id, userA.id, [
          { kind: "labor", description: "Should not be created", quantity: 1, unitPriceCents: 100 },
        ]),
      ),
    ).rejects.toThrow(QuoteAlreadyExistsError);
  });

  it("cross-org access: org B cannot read org A's quote via its own (legitimate) context", async () => {
    const crossOrgQuote = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => quoteRepository.getForJob(tx, orgB.id, jobA.id),
    );
    expect(crossOrgQuote).toBeNull();
  });

  it("cross-org line-item mutation is rejected: org B cannot edit or delete a line item on org A's quote", async () => {
    const quote = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => quoteRepository.getForJob(tx, orgA.id, jobA.id),
    );
    const lineItemId = quote!.lineItems[0].id;

    const updateResult = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) =>
        quoteRepository.updateLineItem(tx, orgB.id, jobA.id, lineItemId, {
          unitPriceCents: 1,
        }),
    );
    expect(updateResult).toBeNull();

    const removeResult = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => quoteRepository.removeLineItem(tx, orgB.id, jobA.id, lineItemId),
    );
    expect(removeResult).toBeNull();

    // Confirm it genuinely wasn't touched.
    const stillIntact = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => quoteRepository.getForJob(tx, orgA.id, jobA.id),
    );
    expect(stillIntact?.lineItems).toHaveLength(2);
  });

  it("a material-kind line item is editable/deletable through the same path as a labor line (kind is provenance, not a restriction)", async () => {
    const quote = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => quoteRepository.getForJob(tx, orgA.id, jobA.id),
    );
    const materialLine = quote!.lineItems.find((li) => li.kind === "material")!;

    const updated = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        quoteRepository.updateLineItem(tx, orgA.id, jobA.id, materialLine.id, {
          quantity: 4,
        }),
    );
    const updatedLine = updated!.lineItems.find((li) => li.id === materialLine.id);
    expect(updatedLine?.quantity).toBe(4);
    expect(updatedLine?.lineTotalCents).toBe(4 * 333);
    // Recomputed from every persisted line, not just the one edited.
    expect(updated!.subtotalCents).toBe(4 * 333 + 45000);
  });
});
