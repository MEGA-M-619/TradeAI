import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  dbTestsEnabled,
  requireEnv,
  createAdminSupabaseClient,
  createPrivilegedPool,
} from "./helpers";

/**
 * Storage is a SECOND, INDEPENDENT enforcement path -- it does not use the
 * app.current_org_id GUC that governs every other tenant table, because
 * Storage requests never touch the Prisma/app_user connection. They arrive
 * as role `authenticated` and are gated by storage.objects policies that
 * re-derive membership from organization_memberships via auth.uid().
 *
 * These tests therefore drive the real Storage API with real user
 * sessions, rather than going through the repository layer.
 *
 * See prisma/migrations/20260816000008_evidence_storage/migration.sql.
 */
const BUCKET = "job-evidence";

// 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(!dbTestsEnabled)("evidence storage tenant isolation", () => {
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  let privileged: ReturnType<typeof createPrivilegedPool>;

  let userA: { id: string; client: SupabaseClient };
  let userB: { id: string; client: SupabaseClient };
  let orgA: string;
  let orgB: string;
  let jobA: string;
  let jobB: string;
  let objectA: string;

  async function makeUser(label: string) {
    const email = `tradeai-evst-${label}-${randomUUID()}@example.invalid`;
    const password = `Test-${randomUUID()}-!`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("user create failed");

    const client = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;

    await privileged.query(
      `insert into public.users (id, email, updated_at)
       values ($1::uuid, $2, now()) on conflict (id) do nothing`,
      [data.user.id, email],
    );
    return { id: data.user.id, email, client };
  }

  async function seedOrg(userId: string, name: string) {
    const org = await privileged.query(
      `insert into public.organizations (name, updated_at) values ($1, now()) returning id`,
      [name],
    );
    const orgId: string = org.rows[0].id;
    await privileged.query(
      `insert into public.organization_memberships (organization_id, user_id, role)
       values ($1::uuid, $2::uuid, 'owner')`,
      [orgId, userId],
    );
    const customer = await privileged.query(
      `insert into public.customers (organization_id, name, updated_at)
       values ($1::uuid, 'Fixture', now()) returning id`,
      [orgId],
    );
    const job = await privileged.query(
      `insert into public.jobs (organization_id, customer_id, created_by_user_id, title, updated_at)
       values ($1::uuid, $2::uuid, $3::uuid, 'Fixture', now()) returning id`,
      [orgId, customer.rows[0].id, userId],
    );
    return { orgId, jobId: job.rows[0].id as string };
  }

  /** Authoritative check -- the Storage API reports success misleadingly
   * in some denial cases, so object existence is read from the table. */
  async function objectExists(name: string) {
    const res = await privileged.query(
      `select 1 from storage.objects where bucket_id = $1 and name = $2`,
      [BUCKET, name],
    );
    return res.rowCount === 1;
  }

  beforeAll(async () => {
    admin = createAdminSupabaseClient();
    privileged = createPrivilegedPool();

    userA = await makeUser("a");
    userB = await makeUser("b");
    const a = await seedOrg(userA.id, "EVST Org A");
    const b = await seedOrg(userB.id, "EVST Org B");
    orgA = a.orgId;
    jobA = a.jobId;
    orgB = b.orgId;
    jobB = b.jobId;

    // One real object owned by org A, uploaded the way the app does it.
    objectA = `${orgA}/${jobA}/${randomUUID()}`;
    const signed = await userA.client.storage
      .from(BUCKET)
      .createSignedUploadUrl(objectA);
    if (signed.error) throw signed.error;
    const uploaded = await userA.client.storage
      .from(BUCKET)
      .uploadToSignedUrl(objectA, signed.data.token, PNG, {
        contentType: "image/png",
      });
    if (uploaded.error) throw uploaded.error;
  });

  afterAll(async () => {
    for (const orgId of [orgA, orgB].filter(Boolean)) {
      const objs = await privileged.query(
        `select name from storage.objects where bucket_id = $1 and name like $2`,
        [BUCKET, `${orgId}/%`],
      );
      if (objs.rowCount) {
        await admin.storage.from(BUCKET).remove(objs.rows.map((r) => r.name));
      }
      await privileged.query(`delete from public.evidence where organization_id = $1::uuid`, [orgId]);
      await privileged.query(`delete from public.jobs where organization_id = $1::uuid`, [orgId]);
      await privileged.query(`delete from public.customers where organization_id = $1::uuid`, [orgId]);
      await privileged.query(`delete from public.organization_memberships where organization_id = $1::uuid`, [orgId]);
      await privileged.query(`delete from public.organizations where id = $1::uuid`, [orgId]);
    }
    for (const u of [userA, userB]) {
      if (!u) continue;
      await privileged.query(`delete from public.users where id = $1::uuid`, [u.id]);
      await admin.auth.admin.deleteUser(u.id);
    }
    await privileged.end();
  });

  it("Storage 1: a member can mint an upload URL inside its own org", async () => {
    const { error } = await userA.client.storage
      .from(BUCKET)
      .createSignedUploadUrl(`${orgA}/${jobA}/${randomUUID()}`);
    expect(error).toBeNull();
  });

  it("Storage 2: a member cannot mint an upload URL in another org", async () => {
    const { error } = await userA.client.storage
      .from(BUCKET)
      .createSignedUploadUrl(`${orgB}/${jobB}/${randomUUID()}`);
    expect(error).not.toBeNull();
  });

  it("Storage 3: path traversal and malformed keys are rejected", async () => {
    const candidates = [
      `${orgA}/../${orgB}/${jobB}/${randomUUID()}`,
      `${orgA}/${jobA}/../../${orgB}/x`,
      `${orgA}/not-a-uuid/${randomUUID()}`,
      `${orgA}/${jobA}/${randomUUID()}/deeper`,
      `${orgA}/${jobA}`,
      randomUUID(),
      // Uppercase is rejected so two spellings can't alias one object.
      `${orgA.toUpperCase()}/${jobA}/${randomUUID()}`,
    ];
    for (const path of candidates) {
      const { error } = await userA.client.storage
        .from(BUCKET)
        .createSignedUploadUrl(path);
      expect(error, `expected denial for ${path}`).not.toBeNull();
    }
  });

  it("Storage 4: a leading slash is normalized into the caller's own prefix, and cannot escape to another org", async () => {
    // Storage strips the leading slash before the policy sees the name,
    // so this lands inside org A rather than becoming a traversal.
    const id = randomUUID();
    const own = await userA.client.storage
      .from(BUCKET)
      .createSignedUploadUrl(`/${orgA}/${jobA}/${id}`);
    expect(own.error).toBeNull();
    if (!own.error) {
      await userA.client.storage
        .from(BUCKET)
        .uploadToSignedUrl(`/${orgA}/${jobA}/${id}`, own.data.token, PNG, {
          contentType: "image/png",
        });
      const stored = await privileged.query(
        `select name from storage.objects where bucket_id = $1 and name like '%' || $2 || '%'`,
        [BUCKET, id],
      );
      for (const row of stored.rows) {
        expect(row.name.startsWith(`${orgA}/`)).toBe(true);
      }
    }

    // The security-relevant variant: same trick aimed at another org.
    const cross = await userA.client.storage
      .from(BUCKET)
      .createSignedUploadUrl(`/${orgB}/${jobB}/${randomUUID()}`);
    expect(cross.error).not.toBeNull();
  });

  it("Storage 5: a non-member cannot mint a download URL for another org's object", async () => {
    const own = await userA.client.storage.from(BUCKET).createSignedUrl(objectA, 60);
    expect(own.error).toBeNull();

    const cross = await userB.client.storage.from(BUCKET).createSignedUrl(objectA, 60);
    expect(cross.error).not.toBeNull();
  });

  it("Storage 6: a non-member cannot list another org's prefix", async () => {
    const { data, error } = await userB.client.storage.from(BUCKET).list(orgA);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("Storage 7: an anonymous client is denied entirely", async () => {
    const anon = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      { auth: { persistSession: false } },
    );
    const download = await anon.storage.from(BUCKET).createSignedUrl(objectA, 60);
    expect(download.error).not.toBeNull();

    const upload = await anon.storage
      .from(BUCKET)
      .createSignedUploadUrl(`${orgA}/${jobA}/${randomUUID()}`);
    expect(upload.error).not.toBeNull();
  });

  it("Storage 8: a non-member cannot delete another org's object (denial is silent)", async () => {
    const result = await userB.client.storage.from(BUCKET).remove([objectA]);
    // Storage reports no error here -- the object list is what proves it.
    expect(result.data ?? []).toHaveLength(0);
    expect(await objectExists(objectA)).toBe(true);
  });

  it("Storage 9: a member can delete its own object", async () => {
    const path = `${orgA}/${jobA}/${randomUUID()}`;
    const signed = await userA.client.storage.from(BUCKET).createSignedUploadUrl(path);
    if (signed.error) throw signed.error;
    await userA.client.storage
      .from(BUCKET)
      .uploadToSignedUrl(path, signed.data.token, PNG, { contentType: "image/png" });
    expect(await objectExists(path)).toBe(true);

    const removed = await userA.client.storage.from(BUCKET).remove([path]);
    expect(removed.data ?? []).toHaveLength(1);
    expect(await objectExists(path)).toBe(false);
  });

  it("Storage 10: the bucket rejects disallowed MIME types and oversize files", async () => {
    const p1 = `${orgA}/${jobA}/${randomUUID()}`;
    const s1 = await userA.client.storage.from(BUCKET).createSignedUploadUrl(p1);
    if (s1.error) throw s1.error;
    const badType = await userA.client.storage
      .from(BUCKET)
      .uploadToSignedUrl(p1, s1.data.token, Buffer.from("nope"), {
        contentType: "text/plain",
      });
    expect(badType.error).not.toBeNull();

    const p2 = `${orgA}/${jobA}/${randomUUID()}`;
    const s2 = await userA.client.storage.from(BUCKET).createSignedUploadUrl(p2);
    if (s2.error) throw s2.error;
    const tooBig = await userA.client.storage
      .from(BUCKET)
      .uploadToSignedUrl(p2, s2.data.token, Buffer.alloc(11 * 1024 * 1024, 1), {
        contentType: "image/png",
      });
    expect(tooBig.error).not.toBeNull();
  });

  it("Storage 11: the bucket is private -- no unauthenticated public URL", async () => {
    const { data } = userA.client.storage.from(BUCKET).getPublicUrl(objectA);
    const res = await fetch(data.publicUrl);
    expect(res.ok).toBe(false);
  });
});
