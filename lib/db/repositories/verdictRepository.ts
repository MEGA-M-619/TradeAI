import type { TenantTxClient } from "@/lib/db/tenantContext";

export type VerdictInput = {
  verdict: "confirmed" | "rejected" | "amended" | "unresolved";
  note?: string | null;
};

/**
 * All tenant-scoped Prisma access for `technician_verdict` must go
 * through this module -- never `prisma.technicianVerdict.*` directly
 * elsewhere (see the no-restricted-syntax rule in eslint.config.mjs).
 *
 * A verdict is upserted, not append-only: unlike the AI's own output
 * (immutable, versioned per assessment run), the technician's judgment on
 * a given finding can reasonably change as work progresses, and unique on
 * findingId is what makes "the current verdict for this finding" a
 * well-defined single row rather than a history to reconstruct. This is
 * a deliberate difference from AiAssessment's append-only design, not an
 * inconsistency: the finding it judges never changes, so revising the
 * verdict in place does not rewrite what the model said.
 */
export const verdictRepository = {
  async upsert(
    tx: TenantTxClient,
    orgId: string,
    assessmentId: string,
    findingId: string,
    createdByUserId: string,
    data: VerdictInput,
  ) {
    return tx.technicianVerdict.upsert({
      where: { findingId },
      create: {
        organizationId: orgId,
        assessmentId,
        findingId,
        verdict: data.verdict,
        note: data.note ?? null,
        createdByUserId,
      },
      update: {
        verdict: data.verdict,
        note: data.note ?? null,
        createdByUserId,
      },
    });
  },

  async listForAssessment(tx: TenantTxClient, orgId: string, assessmentId: string) {
    return tx.technicianVerdict.findMany({
      where: { organizationId: orgId, assessmentId },
    });
  },
};
