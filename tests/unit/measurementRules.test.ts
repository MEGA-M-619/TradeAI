import { describe, expect, it } from "vitest";
import { evaluateMeasurementResult } from "@/lib/diagnostics/measurementRules";
import { MEASUREMENT_TEST_TYPES } from "@/lib/validation/measurement";

describe("evaluateMeasurementResult", () => {
  describe("no expected range supplied", () => {
    it("returns not_applicable when both bounds are omitted", () => {
      expect(evaluateMeasurementResult({ value: 120 })).toBe("not_applicable");
    });

    it("returns not_applicable when both bounds are explicitly null", () => {
      expect(
        evaluateMeasurementResult({
          value: 120,
          expectedMin: null,
          expectedMax: null,
        }),
      ).toBe("not_applicable");
    });

    it("does not treat a zero value as an omitted bound (not_applicable only fires on missing bounds, not a falsy value)", () => {
      expect(evaluateMeasurementResult({ value: 0 })).toBe("not_applicable");
      expect(
        evaluateMeasurementResult({ value: 0, expectedMin: 0, expectedMax: 0 }),
      ).toBe("pass");
    });
  });

  describe("two-sided range", () => {
    it("passes a value strictly inside the range", () => {
      expect(
        evaluateMeasurementResult({ value: 118, expectedMin: 114, expectedMax: 126 }),
      ).toBe("pass");
    });

    it("passes a value exactly at the lower bound (inclusive)", () => {
      expect(
        evaluateMeasurementResult({ value: 114, expectedMin: 114, expectedMax: 126 }),
      ).toBe("pass");
    });

    it("passes a value exactly at the upper bound (inclusive)", () => {
      expect(
        evaluateMeasurementResult({ value: 126, expectedMin: 114, expectedMax: 126 }),
      ).toBe("pass");
    });

    it("fails a value below the lower bound", () => {
      expect(
        evaluateMeasurementResult({ value: 113.9, expectedMin: 114, expectedMax: 126 }),
      ).toBe("fail");
    });

    it("fails a value above the upper bound", () => {
      expect(
        evaluateMeasurementResult({ value: 126.1, expectedMin: 114, expectedMax: 126 }),
      ).toBe("fail");
    });

    it("passes when the range collapses to a single exact target value the reading matches", () => {
      expect(
        evaluateMeasurementResult({ value: 0, expectedMin: 0, expectedMax: 0 }),
      ).toBe("pass");
    });

    it("fails when the range collapses to a single exact target value the reading misses", () => {
      expect(
        evaluateMeasurementResult({ value: 0.4, expectedMin: 0, expectedMax: 0 }),
      ).toBe("fail");
    });
  });

  describe("half-open ranges (only one bound supplied)", () => {
    it("passes any value at or above a minimum-only bound", () => {
      expect(evaluateMeasurementResult({ value: 2.5, expectedMin: 1 })).toBe(
        "pass",
      );
      expect(evaluateMeasurementResult({ value: 1, expectedMin: 1 })).toBe(
        "pass",
      );
    });

    it("fails a value below a minimum-only bound", () => {
      expect(evaluateMeasurementResult({ value: 0.9, expectedMin: 1 })).toBe(
        "fail",
      );
    });

    it("passes any value at or below a maximum-only bound", () => {
      expect(evaluateMeasurementResult({ value: 2, expectedMax: 5 })).toBe(
        "pass",
      );
      expect(evaluateMeasurementResult({ value: 5, expectedMax: 5 })).toBe(
        "pass",
      );
    });

    it("fails a value above a maximum-only bound", () => {
      expect(evaluateMeasurementResult({ value: 5.1, expectedMax: 5 })).toBe(
        "fail",
      );
    });
  });

  describe("negative and fractional values (polarity- and magnitude-agnostic)", () => {
    it("evaluates a negative DC voltage reading against a negative range", () => {
      expect(
        evaluateMeasurementResult({
          value: -12.1,
          expectedMin: -12.5,
          expectedMax: -11.5,
        }),
      ).toBe("pass");
    });

    it("fails a negative value outside a negative range", () => {
      expect(
        evaluateMeasurementResult({
          value: -13,
          expectedMin: -12.5,
          expectedMax: -11.5,
        }),
      ).toBe("fail");
    });

    it("handles very small fractional values (e.g. a ground impedance reading in ohms)", () => {
      expect(
        evaluateMeasurementResult({
          value: 0.021,
          expectedMin: 0,
          expectedMax: 0.05,
        }),
      ).toBe("pass");
    });

    it("handles very large values (e.g. an insulation resistance reading in megohms)", () => {
      expect(
        evaluateMeasurementResult({ value: 250, expectedMin: 1 }),
      ).toBe("pass");
    });
  });

  describe("defensive/adversarial inputs (not expected from the validated API path)", () => {
    it("returns inconclusive for a NaN value", () => {
      expect(
        evaluateMeasurementResult({ value: NaN, expectedMin: 0, expectedMax: 10 }),
      ).toBe("inconclusive");
    });

    it("returns inconclusive for an infinite value", () => {
      expect(
        evaluateMeasurementResult({
          value: Infinity,
          expectedMin: 0,
          expectedMax: 10,
        }),
      ).toBe("inconclusive");
      expect(
        evaluateMeasurementResult({
          value: -Infinity,
          expectedMin: 0,
          expectedMax: 10,
        }),
      ).toBe("inconclusive");
    });

    it("returns inconclusive for a non-finite expectedMin", () => {
      expect(
        evaluateMeasurementResult({ value: 5, expectedMin: NaN, expectedMax: 10 }),
      ).toBe("inconclusive");
    });

    it("returns inconclusive for a non-finite expectedMax", () => {
      expect(
        evaluateMeasurementResult({ value: 5, expectedMin: 0, expectedMax: Infinity }),
      ).toBe("inconclusive");
    });

    it("returns inconclusive for an inverted range (expectedMin > expectedMax)", () => {
      expect(
        evaluateMeasurementResult({ value: 5, expectedMin: 10, expectedMax: 0 }),
      ).toBe("inconclusive");
    });

    it("a non-finite value takes precedence over an also-invalid range", () => {
      // Whichever check runs first, the result must still be inconclusive
      // rather than accidentally falling through to pass/fail.
      expect(
        evaluateMeasurementResult({ value: NaN, expectedMin: 10, expectedMax: 0 }),
      ).toBe("inconclusive");
    });
  });

  describe("test-type agnosticism", () => {
    // The engine intentionally has no per-testType branch (see the module
    // doc comment): it evaluates a numeric reading against whatever range
    // was supplied, the same way regardless of what physical quantity the
    // number represents. This iterates the full closed MeasurementTestType
    // vocabulary to prove that holds for every currently supported type,
    // not just the ones exercised elsewhere in this file.
    for (const testType of MEASUREMENT_TEST_TYPES) {
      it(`evaluates a passing in-range reading for test type "${testType}"`, () => {
        expect(
          evaluateMeasurementResult({ value: 5, expectedMin: 0, expectedMax: 10 }),
        ).toBe("pass");
      });

      it(`evaluates a failing out-of-range reading for test type "${testType}"`, () => {
        expect(
          evaluateMeasurementResult({ value: 15, expectedMin: 0, expectedMax: 10 }),
        ).toBe("fail");
      });

      it(`evaluates a not_applicable reading with no supplied range for test type "${testType}"`, () => {
        expect(evaluateMeasurementResult({ value: 5 })).toBe("not_applicable");
      });
    }
  });

  it("does not mutate its input", () => {
    const input = { value: 5, expectedMin: 0, expectedMax: 10 };
    const frozen = JSON.parse(JSON.stringify(input));
    evaluateMeasurementResult(input);
    expect(input).toEqual(frozen);
  });

  it("is a pure function: the same input always produces the same result", () => {
    const input = { value: 7.5, expectedMin: 5, expectedMax: 10 };
    const first = evaluateMeasurementResult(input);
    const second = evaluateMeasurementResult({ ...input });
    expect(first).toBe(second);
    expect(first).toBe("pass");
  });
});
