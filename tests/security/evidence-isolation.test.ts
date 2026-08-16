import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  dbTestsEnabled,
  createAdminSupabaseClient,
  createPrivilegedPool,
} from "./helpers";
import { withTenantContext } from "@/lib/db/tenantContext";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { userRepository } from "@/lib/db/repositories/userRepository";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { buildEvidenceKey } from "@/lib/storage/evidenceStorage";

// Phase 2 extension of the tenant-isolation suite. Covers the evidence
// metadata table with the same threat model as customers/jobs. The
// Storage layer -- a completely separate enforcement path -- is covered by
// evidence-storage-isolation.test.ts.
describe.skipIf(!dbTestsEnabled)("evidence tenant isolation", () => {
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  let privileged: ReturnType<typeof createPrivilegedPool>;

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let orgA: { id: string };
  let orgB: { id: string };
  let jobA: { id: string };
  let evidenceA: { id: string };

  beforeAll(async () => {
    admin = createAdminSupabaseClient();
    privileged = createPrivilegedPool();

    const emailA = `tradeai-ev-a-${randomUUID()}@example.invalid`;
    const emailB = `tradeai-ev-b-${randomUUID()}@example.invalid`;

    const { data: cA, error: eA } = await admin.auth.admin.createUser({
      email: emailA,
      email_confirm: true,
    });
    if (eA || !cA.user) throw eA ?? new Error("user A create failed");
    const { data: cB, error: eB } = await admin.auth.admin.createUser({
      email: emailB,
      email_confirm: true,
    });
    if (eB || !cB.user) throw eB ?? new Error("user B create failed");

    userA = { id: cA.user.id, email: emailA };
    userB = { id: cB.user.id, email: emailB };

    await userRepository.ensureProfile(userA.id, userA.email);
    await userRepository.ensureProfile(userB.id, userB.email);

    orgA = await organizationRepository.create(userA.id, "EV Test Org A");
    orgB = await organizationRepository.create(userB.id, "EV Test Org B");

    const customerA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => customerRepository.create(tx, orgA.id, { name: "Alice" }),
    );
    jobA = await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      jobRepository.create(tx, orgA.id, userA.id, {
        customerId: customerA.id,
        title: "Panel inspection",
      }),
    );

    const id = randomUUID();
    evidenceA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        evidenceRepository.create(tx, orgA.id, {
          id,
          jobId: jobA.id,
          uploadedByUserId: userA.id,
          storageKey: buildEvidenceKey(orgA.id, jobA.id, id),
          mimeType: "image/jpeg",
        }),
    );
  });

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
    if (orgIds.length) {
      await privileged.query(
        `delete from public.evidence where organization_id = any($1::uuid[])`,
        [orgIds],
      );
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
    for (const u of [userA, userB]) {
      if (!u) continue;
      await privileged.query(`delete from public.users where id = $1::uuid`, [u.id]);
      await admin.auth.admin.deleteUser(u.id);
    }
    await privileged.end();
  });

  it("Evidence 1: org B cannot read org A's evidence", async () => {
    const rows = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => evidenceRepository.listForJob(tx, orgB.id, jobA.id),
    );
    expect(rows).toHaveLength(0);
  });

  it("Evidence 2: org B cannot fetch org A's evidence by its real id", async () => {
    const row = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => evidenceRepository.getById(tx, orgB.id, jobA.id, evidenceA.id),
    );
    expect(row).toBeNull();
  });

  it("Evidence 3: a forged org context still cannot reach org A's evidence", async () => {
    // User B claims org A's id without holding a membership row. RLS
    // re-derives membership via is_member_of() rather than trusting the
    // GUC, so this must still return nothing.
    const rows = await withTenantContext(
      { userId: userB.id, orgId: orgA.id },
      (tx) => evidenceRepository.listForJob(tx, orgA.id, jobA.id),
    );
    expect(rows).toHaveLength(0);
  });

  it("Evidence 4: org B cannot soft-delete org A's evidence", async () => {
    await expect(
      withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
        evidenceRepository.softDelete(
          tx,
          orgB.id,
          jobA.id,
          evidenceA.id,
          userB.id,
        ),
      ),
    ).rejects.toThrow();

    const still = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => evidenceRepository.getById(tx, orgA.id, jobA.id, evidenceA.id),
    );
    expect(still?.deletedAt).toBeNull();
  });

  it("Evidence 5: missing org context yields no rows", async () => {
    const rows = await withTenantContext(
      { userId: userA.id, orgId: null },
      (tx) => evidenceRepository.listForJob(tx, orgA.id, jobA.id),
    );
    expect(rows).toHaveLength(0);
  });

  it("Evidence 6: listForJob hides pending and tombstoned rows", async () => {
    // The fixture row is still `pending` -- it must not be visible.
    const beforeReady = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => evidenceRepository.listForJob(tx, orgA.id, jobA.id),
    );
    expect(beforeReady.map((r) => r.id)).not.toContain(evidenceA.id);

    await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      evidenceRepository.markReady(tx, orgA.id, jobA.id, evidenceA.id, {
        byteSize: 1234,
      }),
    );
    const afterReady = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => evidenceRepository.listForJob(tx, orgA.id, jobA.id),
    );
    expect(afterReady.map((r) => r.id)).toContain(evidenceA.id);

    await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      evidenceRepository.softDelete(
        tx,
        orgA.id,
        jobA.id,
        evidenceA.id,
        userA.id,
      ),
    );
    const afterDelete = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => evidenceRepository.listForJob(tx, orgA.id, jobA.id),
    );
    expect(afterDelete.map((r) => r.id)).not.toContain(evidenceA.id);

    // Tombstone retained rather than row-deleted, so provenance survives.
    const raw = await privileged.query(
      `select deleted_at, deleted_by_user_id from public.evidence where id = $1::uuid`,
      [evidenceA.id],
    );
    expect(raw.rowCount).toBe(1);
    expect(raw.rows[0].deleted_at).not.toBeNull();
    expect(raw.rows[0].deleted_by_user_id).toBe(userA.id);
  });

  it("Evidence 7: buildEvidenceKey refuses non-uuid input", () => {
    expect(() => buildEvidenceKey("../evil", jobA.id, randomUUID())).toThrow();
    expect(() => buildEvidenceKey(orgA.id, "not-a-uuid", randomUUID())).toThrow();
    expect(() =>
      buildEvidenceKey(orgA.id.toUpperCase(), jobA.id, randomUUID()),
    ).toThrow();
  });
});
