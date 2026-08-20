import type { TenantTxClient } from "@/lib/db/tenantContext";
import type { DiagnosticCauseStatus } from "@/lib/generated/prisma/client";

export class DiagnosticCauseConflictError extends Error {
  constructor(
    message = "Another candidate cause on this session is already confirmed",
  ) {
    super(message);
    this.name = "DiagnosticCauseConflictError";
  }
}

export type DiagnosticCandidateCauseCreateInput = {
  statement: string;
  recommendedNextTest?: string | null;
};

export type DiagnosticCandidateCauseUpdateInput = {
  status?: DiagnosticCauseStatus;
  recommendedNextTest?: string | null;
  resolvingMeasurementId?: string | null;
};

/**
 * All tenant-scoped Prisma access for `diagnosticCandidateCauses` must go
 * through this module -- never `prisma.diagnosticCandidateCause.*`
 * directly elsewhere (see the no-restricted-syntax rule in
 * eslint.config.mjs). Every function requires an already org-scoped
 * transaction client (from withAuthenticatedOrgContext).
 *
 * `status` is never accepted at creation -- see
 * DiagnosticCandidateCauseCreateInput, which has no status field; the
 * column defaults to `candidate` at the database level -- so `update` is
 * the only code path that can ever set `confirmed`, and therefore the
 * only place the "at most one confirmed cause per session" invariant
 * needs to be enforced.
 */
export const diagnosticCauseRepository = {
  async listForSession(tx: TenantTxClient, orgId: string, sessionId: string) {
    return tx.diagnosticCandidateCause.findMany({
      where: { organizationId: orgId, diagnosticSessionId: sessionId },
      orderBy: { createdAt: "asc" },
    });
  },

  async getById(
    tx: TenantTxClient,
    orgId: string,
    sessionId: string,
    causeId: string,
  ) {
    return tx.diagnosticCandidateCause.findFirst({
      where: {
        id: causeId,
        organizationId: orgId,
        diagnosticSessionId: sessionId,
      },
    });
  },

  async create(
    tx: TenantTxClient,
    orgId: string,
    sessionId: string,
    createdByUserId: string,
    data: DiagnosticCandidateCauseCreateInput,
  ) {
    return tx.diagnosticCandidateCause.create({
      data: {
        organizationId: orgId,
        diagnosticSessionId: sessionId,
        createdByUserId,
        ...data,
      },
    });
  },

  /**
   * Enforces the two deterministic invariants from the approved Phase 3
   * plan, both only reachable through this function:
   *   - at most one `confirmed` cause per session -- confirming a second
   *     one while another is already confirmed throws
   *     DiagnosticCauseConflictError instead of silently succeeding.
   *   - confirming a cause moves its session's status to `diagnosed`.
   *
   * Un-confirming a cause (changing status away from `confirmed`)
   * deliberately does *not* revert the session's status -- the approved
   * plan only specifies the forward transition; reverting is a separate
   * design question left open rather than invented here. Neither
   * invariant is a database constraint -- both rely on this function
   * being the only writer of `status` (enforced by `create` never
   * accepting one).
   */
  async update(
    tx: TenantTxClient,
    orgId: string,
    sessionId: string,
    causeId: string,
    data: DiagnosticCandidateCauseUpdateInput,
  ) {
    if (data.status === "confirmed") {
      const existingConfirmed = await tx.diagnosticCandidateCause.findFirst({
        where: {
          organizationId: orgId,
          diagnosticSessionId: sessionId,
          status: "confirmed",
          id: { not: causeId },
        },
        select: { id: true },
      });
      if (existingConfirmed) {
        throw new DiagnosticCauseConflictError();
      }
    }

    const cause = await tx.diagnosticCandidateCause.update({
      where: {
        id: causeId,
        organizationId: orgId,
        diagnosticSessionId: sessionId,
      },
      data,
    });

    if (data.status === "confirmed") {
      await tx.diagnosticSession.update({
        where: { id: sessionId, organizationId: orgId },
        data: { status: "diagnosed" },
      });
    }

    return cause;
  },
};
