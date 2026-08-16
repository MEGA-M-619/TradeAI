import { describe, expect, it } from "vitest";
import {
  currentBillingPeriod,
  currentBillingPeriodStart,
  nextBillingPeriodStart,
  isQuotaExceeded,
  MONTHLY_ASSESSMENT_QUOTA,
} from "@/lib/ai/quota";

describe("currentBillingPeriod", () => {
  it("formats as YYYY-MM in UTC", () => {
    expect(currentBillingPeriod(new Date("2026-08-16T23:59:59Z"))).toBe("2026-08");
    expect(currentBillingPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  it("pads single-digit months", () => {
    expect(currentBillingPeriod(new Date("2026-03-05T12:00:00Z"))).toBe("2026-03");
  });

  it("uses UTC, not local time, at a month boundary", () => {
    // 23:30 UTC on the 31st is still July in UTC even if local time has
    // already rolled into August -- this only matters if the test runner's
    // TZ differs from UTC, but asserting the UTC value directly makes the
    // function's contract explicit either way.
    expect(currentBillingPeriod(new Date("2026-07-31T23:30:00Z"))).toBe("2026-07");
  });
});

describe("currentBillingPeriodStart / nextBillingPeriodStart", () => {
  it("returns the first instant of the current UTC month", () => {
    const start = currentBillingPeriodStart(new Date("2026-08-16T23:59:59Z"));
    expect(start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("returns the first instant of next UTC month, including a year rollover", () => {
    expect(nextBillingPeriodStart(new Date("2026-08-16T00:00:00Z")).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(nextBillingPeriodStart(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("isQuotaExceeded", () => {
  it("is false strictly below the limit", () => {
    expect(isQuotaExceeded(0, 100)).toBe(false);
    expect(isQuotaExceeded(99, 100)).toBe(false);
  });

  it("is true at exactly the limit (the limit is a cap on usage, not a target)", () => {
    expect(isQuotaExceeded(100, 100)).toBe(true);
  });

  it("is true above the limit", () => {
    expect(isQuotaExceeded(101, 100)).toBe(true);
  });

  it("defaults to MONTHLY_ASSESSMENT_QUOTA when no limit is given", () => {
    expect(isQuotaExceeded(MONTHLY_ASSESSMENT_QUOTA - 1)).toBe(false);
    expect(isQuotaExceeded(MONTHLY_ASSESSMENT_QUOTA)).toBe(true);
  });

  it("treats zero as a valid (fully-restrictive) limit", () => {
    expect(isQuotaExceeded(0, 0)).toBe(true);
  });
});
