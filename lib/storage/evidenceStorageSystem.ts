import { createClient } from "@supabase/supabase-js";
import { EVIDENCE_BUCKET, EvidenceStorageError } from "@/lib/storage/evidenceStorage";

/**
 * THE ONE PLACE THE SERVICE-ROLE KEY IS USED FOR EVIDENCE BYTES.
 *
 * Every other Storage operation in this app (lib/storage/evidenceStorage.ts)
 * goes through the requesting user's own session, deliberately, so
 * Supabase Storage's RLS stays a genuinely independent second layer. That
 * remains true for every client-facing upload/download/delete flow --
 * this module changes nothing about it.
 *
 * This function exists for a case Phase 2 never had: the Phase 3
 * assessment executor is deployment-agnostic and may run with no live
 * user session at all (an external cron, a queue drain, a retry), so
 * there is no session cookie to build a Storage client from. That is a
 * "narrow, explicitly-reviewed administrative path" in exactly the sense
 * docs/architecture/security.md already carves out for the service-role
 * key (previously used only by tests/security/helpers.ts) -- not a
 * relaxation of the client-facing guarantee.
 *
 * The narrowness is enforced structurally, not just by convention:
 *   - this function only ever downloads a storageKey the caller already
 *     read back from ai_assessment_input, i.e. a key that was already
 *     proven -- through the app's own RLS-scoped repository layer -- to
 *     belong to the exact org+job+assessment being processed;
 *   - it has no delete, list, or upload capability;
 *   - it is not imported by any route handler or client component, only
 *     by lib/ai/executor.ts.
 */

let systemClient: ReturnType<typeof createClient> | null = null;
function getSystemClient() {
  if (!systemClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
      throw new EvidenceStorageError(
        "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set",
      );
    }
    systemClient = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return systemClient;
}

export async function downloadEvidenceObjectAsSystem(
  storageKey: string,
): Promise<Uint8Array> {
  const { data, error } = await getSystemClient()
    .storage.from(EVIDENCE_BUCKET)
    .download(storageKey);

  if (error || !data) {
    throw new EvidenceStorageError(
      error?.message ?? `Could not download evidence object ${storageKey}`,
    );
  }
  return new Uint8Array(await data.arrayBuffer());
}
