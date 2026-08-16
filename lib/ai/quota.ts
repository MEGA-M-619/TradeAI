/**
 * Per-organization monthly quota (D9). Counted in assessment attempts --
 * every AiAssessment row created this month, including ones that go on
 * to fail, since a failed run still consumes tokens and must count
 * against the limit (otherwise repeated failing calls would be a
 * quota-bypass vector). Enforced by counting AiAssessment rows directly
 * (see assessmentRepository.countThisMonth), not by summing
 * AiUsageLedger, so enforcement never depends on the ledger being
 * perfectly consistent.
 */
export const MONTHLY_ASSESSMENT_QUOTA = 100;

/** 'YYYY-MM' in UTC -- a direct equality match against AiUsageLedger's
 * billingPeriod and the boundary countThisMonth() queries against. */
export function currentBillingPeriod(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Start of the current UTC calendar month, for the countThisMonth()
 * createdAt >= boundary query. */
export function currentBillingPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First day of next UTC month -- for surfacing "quota resets on" to the
 * technician in a 409 response. */
export function nextBillingPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Pulled out as its own pure function so the boundary condition is
 * unit-testable without a database -- the route only ever calls this,
 * never repeats the comparison inline. */
export function isQuotaExceeded(
  usedThisMonth: number,
  limit: number = MONTHLY_ASSESSMENT_QUOTA,
): boolean {
  return usedThisMonth >= limit;
}
