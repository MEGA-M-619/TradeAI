import { createSupabaseServerClient } from "@/lib/auth/supabaseServerClient";

/**
 * The evidence Storage boundary.
 *
 * Two rules hold everywhere in this module:
 *
 *  1. Storage keys are CONSTRUCTED here from ids the caller has already
 *     verified -- never accepted from a request. `buildEvidenceKey` is the
 *     only way a key is produced.
 *  2. Every call goes through the *user's own session* client
 *     (createSupabaseServerClient, anon key + session cookie), never the
 *     service-role key. That is what keeps Supabase Storage's RLS in play
 *     as a genuinely independent second layer: the policies re-derive
 *     membership from organization_memberships via auth.uid(), so a bug in
 *     the application layer still cannot reach another tenant's objects.
 *     A service-role client would bypass those policies entirely and
 *     collapse this to single-layer enforcement.
 *
 * See prisma/migrations/20260816000008_evidence_storage/migration.sql for
 * the policies and the empirical findings behind them.
 */

export const EVIDENCE_BUCKET = "job-evidence";

/** How long a download URL stays valid. Short by design: a signed URL is
 * a bearer capability -- verified that anyone holding one can fetch it
 * until it expires -- so it is minted per page render and never logged. */
export const EVIDENCE_SIGNED_URL_TTL_SECONDS = 60 * 15;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `{organizationId}/{jobId}/{evidenceId}`.
 *
 * The ids are asserted to be lowercase UUIDs before use. They already come
 * from verified sources, so this should be unreachable -- but the storage
 * policy accepts exactly this shape and nothing else, and a mismatch here
 * would surface as a confusing RLS denial rather than an obvious bug.
 */
export function buildEvidenceKey(
  organizationId: string,
  jobId: string,
  evidenceId: string,
): string {
  for (const [label, value] of [
    ["organizationId", organizationId],
    ["jobId", jobId],
    ["evidenceId", evidenceId],
  ] as const) {
    if (!UUID_RE.test(value)) {
      throw new Error(`buildEvidenceKey: ${label} is not a lowercase uuid`);
    }
  }
  return `${organizationId}/${jobId}/${evidenceId}`;
}

export class EvidenceStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceStorageError";
  }
}

/** Mints a one-shot upload token for exactly one object path. Gated by the
 * storage INSERT policy, so a key outside the caller's org is rejected by
 * the database, not just by this code. */
export async function createEvidenceUploadUrl(storageKey: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUploadUrl(storageKey);

  if (error || !data) {
    throw new EvidenceStorageError(
      error?.message ?? "Could not create upload URL",
    );
  }
  return { signedUrl: data.signedUrl, token: data.token, path: data.path };
}

/** Batch-mints download URLs for a whole evidence list in one request.
 * Gated by the storage SELECT policy. Returns a key -> URL map; a key the
 * caller may not read simply won't appear. */
export async function createEvidenceDownloadUrls(
  storageKeys: string[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (storageKeys.length === 0) return urls;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrls(storageKeys, EVIDENCE_SIGNED_URL_TTL_SECONDS);

  if (error || !data) {
    throw new EvidenceStorageError(
      error?.message ?? "Could not create download URLs",
    );
  }
  for (const entry of data) {
    if (entry.signedUrl && entry.path) urls.set(entry.path, entry.signedUrl);
  }
  return urls;
}

/**
 * Hard-deletes the stored bytes. Gated by the storage DELETE policy.
 *
 * Verified behaviour that this function exists to contain: `remove()`
 * DENIES SILENTLY -- on an RLS denial it returns no error and an empty
 * data array, which is indistinguishable from "the object was already
 * gone". Trusting the absence of an error would report a successful
 * delete for an object that is still sitting there, so an empty payload
 * triggers an explicit existence probe rather than an assumption.
 *
 * "Already absent" is a normal case, not an edge case: a `pending` row
 * whose upload never completed has no object at all, and deleting it must
 * still succeed. It also makes a retry after a partial failure work.
 *
 * The probe uses the SELECT policy. That is sound here because callers
 * reach this function only after the evidence row has been read back
 * through the RLS-scoped repository, which already proves the key belongs
 * to the caller's org -- so a probe failure means "not there", not "not
 * allowed".
 */
export async function deleteEvidenceObject(
  storageKey: string,
): Promise<"deleted" | "already_absent"> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .remove([storageKey]);

  if (error) {
    throw new EvidenceStorageError(error.message);
  }
  if (data && data.length > 0) {
    return "deleted";
  }

  const probe = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrl(storageKey, 60);

  if (probe.error) {
    return "already_absent";
  }
  throw new EvidenceStorageError(
    "Storage removed nothing but the object is still readable -- refusing to report this as deleted",
  );
}
