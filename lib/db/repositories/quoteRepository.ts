import type { TenantTxClient } from "@/lib/db/tenantContext";

export class QuoteAlreadyExistsError extends Error {
  constructor(message = "This job already has a quote") {
    super(message);
    this.name = "QuoteAlreadyExistsError";
  }
}

export type QuoteLineItemCreateInput = {
  kind: "material" | "labor";
  description: string;
  quantity: number;
  unitPriceCents: number;
  sourceMaterialId?: string | null;
};

export type QuoteLineItemUpdateInput = Partial<{
  description: string;
  quantity: number;
  unitPriceCents: number;
}>;

/**
 * The single point where a line total is ever computed: rounded once,
 * here, to the nearest cent. quantity is a plain count/measure (may be
 * fractional, e.g. 2.5 units); unitPriceCents is already the smallest
 * currency unit. The product is never carried forward as a float and
 * never re-derived from a stored float, so summing already-rounded line
 * totals afterward (computeTotals) is pure integer addition -- no
 * rounding drift can accumulate across a quote.
 */
function computeLineTotalCents(quantity: number, unitPriceCents: number): number {
  return Math.round(quantity * unitPriceCents);
}

/** No tax/discount exists in this schema (see the doc comment on Quote in
 * schema.prisma) -- totalCents equals subtotalCents today, but is its own
 * computed value rather than an alias, so a future tax/discount phase is
 * an additive change here, not a schema change. */
function computeTotals(lineItems: readonly { lineTotalCents: number }[]): {
  subtotalCents: number;
  totalCents: number;
} {
  const subtotalCents = lineItems.reduce((sum, item) => sum + item.lineTotalCents, 0);
  return { subtotalCents, totalCents: subtotalCents };
}

/**
 * All tenant-scoped Prisma access for `quotes`/`quote_line_items` must go
 * through this module -- never `prisma.quote.*`/`prisma.quoteLineItem.*`
 * directly elsewhere (see the no-restricted-syntax rule in
 * eslint.config.mjs). Every function requires an already org-scoped
 * transaction client (from withAuthenticatedOrgContext).
 *
 * Deliberately does not import assessmentRepository or materialRepository
 * -- no repository in this directory imports another. Assembling a
 * quote's initial line items from confirmed findings and the job's
 * current materials is the API route's job (see
 * app/api/.../quote/generate/route.ts), matching how the measurements
 * POST route already coordinates jobRepository/circuitRepository/
 * evidenceRepository directly rather than through a repository-to-
 * repository call.
 */
export const quoteRepository = {
  async getForJob(tx: TenantTxClient, orgId: string, jobId: string) {
    return tx.quote.findFirst({
      where: { organizationId: orgId, jobId },
      include: { lineItems: { orderBy: { createdAt: "asc" } } },
    });
  },

  /**
   * Creates the job's one and only quote from an already-assembled list
   * of line items. Refuses (QuoteAlreadyExistsError) rather than
   * replacing an existing quote -- "one current quote per job" also means
   * generation is a one-time action, not a way to discard whatever a
   * technician has since added or edited. The jobs.quote_id UNIQUE
   * constraint backs this at the database level too.
   */
  async create(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    createdByUserId: string,
    lineItems: readonly QuoteLineItemCreateInput[],
  ) {
    const existing = await tx.quote.findFirst({
      where: { organizationId: orgId, jobId },
      select: { id: true },
    });
    if (existing) throw new QuoteAlreadyExistsError();

    const preparedLines = lineItems.map((item) => ({
      organizationId: orgId,
      kind: item.kind,
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: computeLineTotalCents(item.quantity, item.unitPriceCents),
      sourceMaterialId: item.sourceMaterialId ?? null,
    }));
    const { subtotalCents, totalCents } = computeTotals(preparedLines);

    return tx.quote.create({
      data: {
        organizationId: orgId,
        jobId,
        createdByUserId,
        subtotalCents,
        totalCents,
        lineItems: { create: preparedLines },
      },
      include: { lineItems: { orderBy: { createdAt: "asc" } } },
    });
  },

  /** The only way a technician can add a line item directly -- always
   * `kind: "labor"`. A `material` line only ever comes from `create`'s
   * snapshot of the job's Materials at generation time; there is no
   * function here that accepts a caller-supplied `kind`. */
  async addLaborLine(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    data: { description: string; quantity: number; unitPriceCents: number },
  ) {
    const quote = await tx.quote.findFirst({
      where: { organizationId: orgId, jobId },
      select: { id: true },
    });
    if (!quote) return null;

    await tx.quoteLineItem.create({
      data: {
        organizationId: orgId,
        quoteId: quote.id,
        kind: "labor",
        description: data.description,
        quantity: data.quantity,
        unitPriceCents: data.unitPriceCents,
        lineTotalCents: computeLineTotalCents(data.quantity, data.unitPriceCents),
        sourceMaterialId: null,
      },
    });

    return recomputeAndReturn(tx, orgId, quote.id);
  },

  /** Applies to a line item of either kind -- kind records provenance,
   * not an editing restriction (see the doc comment on QuoteLineItem in
   * schema.prisma). Unset fields keep their current value; quantity/price
   * changes always recompute lineTotalCents server-side, never trusting
   * one supplied by the caller. */
  async updateLineItem(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    lineItemId: string,
    data: QuoteLineItemUpdateInput,
  ) {
    const quote = await tx.quote.findFirst({
      where: { organizationId: orgId, jobId },
      select: { id: true },
    });
    if (!quote) return null;

    const existing = await tx.quoteLineItem.findFirst({
      where: { id: lineItemId, organizationId: orgId, quoteId: quote.id },
    });
    if (!existing) return null;

    const quantity = data.quantity ?? existing.quantity;
    const unitPriceCents = data.unitPriceCents ?? existing.unitPriceCents;

    await tx.quoteLineItem.update({
      where: { id: lineItemId, organizationId: orgId, quoteId: quote.id },
      data: {
        description: data.description ?? existing.description,
        quantity,
        unitPriceCents,
        lineTotalCents: computeLineTotalCents(quantity, unitPriceCents),
      },
    });

    return recomputeAndReturn(tx, orgId, quote.id);
  },

  async removeLineItem(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    lineItemId: string,
  ) {
    const quote = await tx.quote.findFirst({
      where: { organizationId: orgId, jobId },
      select: { id: true },
    });
    if (!quote) return null;

    const deleted = await tx.quoteLineItem.deleteMany({
      where: { id: lineItemId, organizationId: orgId, quoteId: quote.id },
    });
    if (deleted.count === 0) return null;

    return recomputeAndReturn(tx, orgId, quote.id);
  },
};

/** Re-derives subtotal/total from every persisted line item and writes
 * them back -- the only place either column is ever set after creation,
 * so the stored totals can never drift from the rows that make them up. */
async function recomputeAndReturn(
  tx: TenantTxClient,
  orgId: string,
  quoteId: string,
) {
  const lineItems = await tx.quoteLineItem.findMany({
    where: { organizationId: orgId, quoteId },
    orderBy: { createdAt: "asc" },
  });
  const { subtotalCents, totalCents } = computeTotals(lineItems);

  return tx.quote.update({
    where: { id: quoteId, organizationId: orgId },
    data: { subtotalCents, totalCents },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
}
