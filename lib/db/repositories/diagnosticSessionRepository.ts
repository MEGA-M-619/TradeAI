import type { TenantTxClient } from "@/lib/db/tenantContext";

export type DiagnosticSessionInput = {
  symptom: string;
};

/**
 * All tenant-scoped Prisma access for `diagnosticSessions` must go
 * through this module -- never `prisma.diagnosticSession.*` directly
 * elsewhere (see the no-restricted-syntax rule in eslint.config.mjs).
 * Every function requires an already org-scoped transaction client (from
 * withAuthenticatedOrgContext).
 */
export const diagnosticSessionRepository = {
  async listForJob(tx: TenantTxClient, orgId: string, jobId: string) {
    return tx.diagnosticSession.findMany({
      where: { organizationId: orgId, jobId },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    sessionId: string,
  ) {
    return tx.diagnosticSession.findFirst({
      where: { id: sessionId, organizationId: orgId, jobId },
    });
  },

  /** Detail-view read: the session plus every candidate cause recorded
   * against it, oldest first. */
  async getFullById(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    sessionId: string,
  ) {
    return tx.diagnosticSession.findFirst({
      where: { id: sessionId, organizationId: orgId, jobId },
      include: { causes: { orderBy: { createdAt: "asc" } } },
    });
  },

  async create(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    createdByUserId: string,
    data: DiagnosticSessionInput,
  ) {
    return tx.diagnosticSession.create({
      data: { organizationId: orgId, jobId, createdByUserId, ...data },
    });
  },

  /**
   * Unconditional: a technician may abandon a session in any state,
   * including one already `diagnosed` (a confirmed cause can turn out to
   * be wrong after the fact). Unlike diagnosticCauseRepository.update,
   * there is no invariant to enforce here.
   */
  async abandon(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    sessionId: string,
  ) {
    return tx.diagnosticSession.update({
      where: { id: sessionId, organizationId: orgId, jobId },
      data: { status: "abandoned" },
    });
  },

  /** Added in Phase 3B for the session PATCH route -- editing the symptom
   * text never touches `status`, which is exactly why it's a separate
   * function from `abandon` rather than a general-purpose `update`. */
  async updateSymptom(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    sessionId: string,
    symptom: string,
  ) {
    return tx.diagnosticSession.update({
      where: { id: sessionId, organizationId: orgId, jobId },
      data: { symptom },
    });
  },
};
