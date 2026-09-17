import { describe, expect, it } from "vitest";
import {
  explainFailure,
  formatQuantity,
  QUANTITY_UNITS,
  solvableTargets,
  solve,
  type CalculationFailureReason,
  type ElectricalQuantity,
} from "@/lib/calculations/electrical";

/** Narrowing helper: asserts success and hands back the success branch. */
function expectOk(outcome: ReturnType<typeof solve>) {
  if (!outcome.ok) {
    throw new Error(`expected success, got refusal: ${outcome.reason}`);
  }
  return outcome;
}

function expectRefusal(
  outcome: ReturnType<typeof solve>,
  reason: CalculationFailureReason,
) {
  if (outcome.ok) {
    throw new Error(`expected refusal ${reason}, got value ${outcome.value}`);
  }
  expect(outcome.reason).toBe(reason);
}

describe("solve — Ohm's law", () => {
  it("computes voltage from current and resistance (V = I × R)", () => {
    const result = expectOk(solve("voltage", { current: 2, resistance: 60 }));
    expect(result.value).toBe(120);
    expect(result.unit).toBe("V");
    expect(result.formula).toBe("V = I × R");
    expect(result.derivedFrom).toEqual(["current", "resistance"]);
  });

  it("computes current from voltage and resistance (I = V ÷ R)", () => {
    const result = expectOk(solve("current", { voltage: 120, resistance: 60 }));
    expect(result.value).toBe(2);
    expect(result.unit).toBe("A");
  });

  it("computes resistance from voltage and current (R = V ÷ I)", () => {
    const result = expectOk(solve("resistance", { voltage: 120, current: 2 }));
    expect(result.value).toBe(60);
    expect(result.unit).toBe("Ω");
  });
});

describe("solve — power relationships", () => {
  it("computes power from voltage and current (P = V × I)", () => {
    const result = expectOk(solve("power", { voltage: 120, current: 2 }));
    expect(result.value).toBe(240);
    expect(result.unit).toBe("W");
    expect(result.formula).toBe("P = V × I");
  });

  it("computes power from current and resistance (P = I² × R)", () => {
    const result = expectOk(solve("power", { current: 2, resistance: 60 }));
    expect(result.value).toBe(240);
    expect(result.formula).toBe("P = I² × R");
  });

  it("computes power from voltage and resistance (P = V² ÷ R)", () => {
    const result = expectOk(solve("power", { voltage: 120, resistance: 60 }));
    expect(result.value).toBe(240);
    expect(result.formula).toBe("P = V² ÷ R");
  });

  it("computes voltage from power and current (V = P ÷ I)", () => {
    expect(expectOk(solve("voltage", { power: 240, current: 2 })).value).toBe(120);
  });

  it("computes voltage from power and resistance (V = √(P × R))", () => {
    expect(expectOk(solve("voltage", { power: 240, resistance: 60 })).value).toBe(120);
  });

  it("computes current from power and voltage (I = P ÷ V)", () => {
    expect(expectOk(solve("current", { power: 240, voltage: 120 })).value).toBe(2);
  });

  it("computes current from power and resistance (I = √(P ÷ R))", () => {
    expect(expectOk(solve("current", { power: 240, resistance: 60 })).value).toBe(2);
  });

  it("computes resistance from voltage and power (R = V² ÷ P)", () => {
    expect(expectOk(solve("resistance", { voltage: 120, power: 240 })).value).toBe(60);
  });

  it("computes resistance from power and current (R = P ÷ I²)", () => {
    expect(expectOk(solve("resistance", { power: 240, current: 2 })).value).toBe(60);
  });
});

describe("solve — round-trip consistency", () => {
  // Every quantity derived from the other two must reproduce the original
  // circuit. This is the property that actually matters in the field: a
  // technician may solve in any direction and must not get a different
  // circuit depending on which way they went.
  const circuit = { voltage: 230, current: 4.6, resistance: 50, power: 1058 };

  const quantities: ElectricalQuantity[] = [
    "voltage",
    "current",
    "resistance",
    "power",
  ];

  for (const target of quantities) {
    it(`re-derives ${target} from every valid pair of the remaining knowns`, () => {
      const others = quantities.filter((q) => q !== target);
      for (const a of others) {
        for (const b of others) {
          if (a === b) continue;
          const outcome = solve(target, { [a]: circuit[a], [b]: circuit[b] });
          if (!outcome.ok) continue; // pair may not determine the target
          expect(outcome.value).toBeCloseTo(circuit[target], 6);
        }
      }
    });
  }
});

describe("solve — refusals rather than misleading numbers", () => {
  it("refuses when only one quantity is known", () => {
    expectRefusal(solve("power", { voltage: 120 }), "insufficient_inputs");
  });

  it("refuses when nothing is known", () => {
    expectRefusal(solve("voltage", {}), "insufficient_inputs");
  });

  it("refuses to solve for a quantity that was itself supplied", () => {
    expectRefusal(
      solve("voltage", { voltage: 120, current: 2 }),
      "target_already_known",
    );
  });

  it("refuses NaN input", () => {
    expectRefusal(
      solve("power", { voltage: Number.NaN, current: 2 }),
      "non_finite_input",
    );
  });

  it("refuses Infinity input", () => {
    expectRefusal(
      solve("power", { voltage: Number.POSITIVE_INFINITY, current: 2 }),
      "non_finite_input",
    );
  });

  it("refuses a negative input instead of silently taking its magnitude", () => {
    expectRefusal(solve("power", { voltage: -120, current: 2 }), "negative_input");
  });

  it("refuses division by zero resistance (I = V ÷ R)", () => {
    expectRefusal(
      solve("current", { voltage: 120, resistance: 0 }),
      "division_by_zero",
    );
  });

  it("refuses division by zero current (R = V ÷ I)", () => {
    expectRefusal(
      solve("resistance", { voltage: 120, current: 0 }),
      "division_by_zero",
    );
  });

  it("refuses a result that overflows to Infinity", () => {
    expectRefusal(
      solve("power", { voltage: Number.MAX_VALUE, current: Number.MAX_VALUE }),
      "non_finite_result",
    );
  });

  it("every failure reason has a non-empty user-facing message", () => {
    const reasons: CalculationFailureReason[] = [
      "insufficient_inputs",
      "target_already_known",
      "non_finite_input",
      "negative_input",
      "division_by_zero",
      "non_finite_result",
    ];
    for (const reason of reasons) {
      expect(explainFailure(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("solve — zero accepted where physically meaningful", () => {
  it("accepts zero voltage as an input (open contact reads 0 V)", () => {
    const result = expectOk(solve("power", { voltage: 0, current: 2 }));
    expect(result.value).toBe(0);
  });

  it("accepts zero current when it is not a denominator", () => {
    expect(expectOk(solve("power", { current: 0, resistance: 60 })).value).toBe(0);
  });
});

describe("solvableTargets", () => {
  it("lists nothing when fewer than two quantities are known", () => {
    expect(solvableTargets({ voltage: 120 })).toEqual([]);
  });

  it("lists the two remaining quantities when two are known", () => {
    expect(solvableTargets({ voltage: 120, current: 2 }).sort()).toEqual(
      ["power", "resistance"].sort(),
    );
  });

  it("excludes a target that would divide by zero", () => {
    expect(solvableTargets({ voltage: 120, current: 0 })).not.toContain("resistance");
  });
});

describe("formatQuantity", () => {
  it("renders a small leakage current without collapsing it to zero", () => {
    expect(formatQuantity(0.0021, "A")).toBe("0.0021 A");
  });

  it("renders a large load without spurious decimals", () => {
    expect(formatQuantity(2400, "W")).toBe("2,400 W");
  });

  it("drops uninformative trailing zeros on a mid-range value", () => {
    expect(formatQuantity(120.0, "V")).toBe("120 V");
  });

  it("keeps meaningful decimals on a mid-range value", () => {
    expect(formatQuantity(4.55, "A")).toBe("4.55 A");
  });

  it("renders exact zero plainly", () => {
    expect(formatQuantity(0, "V")).toBe("0 V");
  });

  it("renders a non-finite value as a bare em dash, with no unit appended", () => {
    // A unit on a non-value would read as though something was measured.
    expect(formatQuantity(Number.NaN, "V")).toBe("—");
    expect(formatQuantity(Number.POSITIVE_INFINITY, "A")).toBe("—");
  });
});

describe("unit table", () => {
  it("covers every quantity with the correct SI symbol", () => {
    expect(QUANTITY_UNITS).toEqual({
      voltage: "V",
      current: "A",
      resistance: "Ω",
      power: "W",
    });
  });
});
