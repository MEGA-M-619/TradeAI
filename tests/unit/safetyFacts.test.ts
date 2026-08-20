import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FACT_KEYS,
  UNKNOWN_REASONS,
  InvalidFactValueError,
  UnknownFactAccessError,
  allFactsKnown,
  isFactKey,
  isKnown,
  isUnknown,
  isUnknownReason,
  known,
  unknown,
  unknownFactKeys,
  unwrapKnown,
  type Fact,
  type MeasurementFact,
  type SafetyFacts,
} from "@/lib/safety/facts";

const measurement: MeasurementFact = {
  measurementId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  testType: "voltage_ac",
  circuitId: "9c858901-8a57-4791-81fe-4c455b099bc9",
  value: 120,
  unit: "V",
  result: "pass",
  criterion: { source: "technician_supplied", expectedMin: 114, expectedMax: 126 },
  recordedAt: "2026-08-19T12:00:00.000Z",
};

function factsWith(overrides: Partial<SafetyFacts> = {}): SafetyFacts {
  return {
    circuit_under_investigation: known({ circuitId: "c-1", label: "Kitchen" }),
    measurements_on_job: known([measurement]),
    measurements_on_circuit: known([measurement]),
    // Known([]) is the normal case: a job with no AI assessment has no
    // flagged hazards, which is a fact rather than an unknown.
    ai_hazard_categories: known([] as const),
    ...overrides,
  };
}

describe("Known and Unknown remain distinguishable", () => {
  it("a Known fact reports known: true and carries its value", () => {
    const fact = known(42);
    expect(fact.known).toBe(true);
    expect(fact.value).toBe(42);
    expect(isKnown(fact)).toBe(true);
    expect(isUnknown(fact)).toBe(false);
  });

  it("an Unknown fact reports known: false and carries a reason and detail", () => {
    const fact = unknown("not_recorded", "no measurement references a circuit");
    expect(fact.known).toBe(false);
    expect(fact.reason).toBe("not_recorded");
    expect(fact.detail).toBe("no measurement references a circuit");
    expect(isUnknown(fact)).toBe(true);
    expect(isKnown(fact)).toBe(false);
  });

  it("an Unknown has no `value` property to read by accident", () => {
    const fact: Fact<number> = unknown("not_recorded", "nothing recorded");
    expect("value" in fact).toBe(false);
  });

  it("Known(false) is a fact, not an unknown", () => {
    const fact = known(false);
    expect(isKnown(fact)).toBe(true);
    expect(isUnknown(fact)).toBe(false);
    expect(unwrapKnown(fact)).toBe(false);
  });

  it("Known(0) is a fact, not an unknown", () => {
    const fact = known(0);
    expect(isKnown(fact)).toBe(true);
    expect(isUnknown(fact)).toBe(false);
    expect(unwrapKnown(fact)).toBe(0);
  });

  it("Known of other falsy-but-meaningful values is preserved", () => {
    expect(unwrapKnown(known(-0))).toBe(-0);
    expect(unwrapKnown(known(Number.NaN))).toBeNaN();
    expect(unwrapKnown(known([]))).toEqual([]);
  });

  it("Known([]) -- we looked and found nothing -- is not the same as Unknown", () => {
    // This distinction is the reason the model exists: an empty result
    // set is an answer; an unknown is the absence of one.
    const emptyButKnown: Fact<readonly MeasurementFact[]> = known(
      [] as readonly MeasurementFact[],
    );
    const notEstablished: Fact<readonly MeasurementFact[]> = unknown(
      "depends_on_unknown_fact",
      "the circuit under investigation is not identified",
    );
    expect(isKnown(emptyButKnown)).toBe(true);
    expect(isKnown(notEstablished)).toBe(false);
    expect(emptyButKnown).not.toEqual(notEstablished);
  });
});

describe("Unknown cannot silently coerce into a usable value", () => {
  const fact: Fact<number> = unknown("not_recorded", "never measured");

  it("unwrapKnown throws instead of returning a default", () => {
    expect(() => unwrapKnown(fact)).toThrow(UnknownFactAccessError);
  });

  it("the thrown error names the reason and the detail", () => {
    expect(() => unwrapKnown(fact)).toThrow(/not_recorded/);
    expect(() => unwrapKnown(fact)).toThrow(/never measured/);
  });

  it("exposes no defaulting accessor of any kind", async () => {
    // An API offering a fallback is an API that turns an unknown into an
    // assumption in one keystroke. There must not be one.
    const moduleExports = await import("@/lib/safety/facts");
    const defaulting =
      /^(unwrapOr|getOr|valueOr|orElse|orDefault|withDefault|coerce|assume|fallback|toValue|getValueOr)/i;
    for (const name of Object.keys(moduleExports)) {
      expect(name).not.toMatch(defaulting);
    }
  });

  it("does not become false, 0, empty string, null or undefined under comparison", () => {
    expect(fact).not.toBe(false);
    expect(fact).not.toBe(0);
    expect(fact).not.toBe("");
    expect(fact).not.toBeNull();
    expect(fact).not.toBeUndefined();
    // And it is emphatically not equal to a Known wrapping any of those.
    expect(fact).not.toEqual(known(false));
    expect(fact).not.toEqual(known(0));
  });
});

describe("null, undefined and blank strings cannot become Known facts", () => {
  it("rejects null", () => {
    expect(() => known(null)).toThrow(InvalidFactValueError);
    expect(() => known(null)).toThrow(/null/);
  });

  it("rejects undefined", () => {
    expect(() => known(undefined)).toThrow(InvalidFactValueError);
    expect(() => known(undefined)).toThrow(/undefined/);
  });

  it("rejects an empty or whitespace-only string", () => {
    for (const blank of ["", "   ", "\t", "\n", " \n\t "]) {
      expect(() => known(blank)).toThrow(InvalidFactValueError);
    }
  });

  it("still accepts a string that merely contains whitespace", () => {
    expect(unwrapKnown(known(" Kitchen ring "))).toBe(" Kitchen ring ");
    expect(unwrapKnown(known("0"))).toBe("0");
  });

  it("the guard is explicit, not a truthiness test", () => {
    // If this were `if (!value)` then false, 0 and "" would all be
    // rejected together and Known(false)/Known(0) would be impossible.
    expect(() => known(false)).not.toThrow();
    expect(() => known(0)).not.toThrow();
    expect(() => known(Number.NaN)).not.toThrow();
  });
});

describe("Unknown explains itself", () => {
  it("requires a reason from the closed vocabulary", () => {
    expect(() =>
      unknown("no_idea" as unknown as "not_recorded", "detail"),
    ).toThrow(InvalidFactValueError);
  });

  it("requires a non-empty detail", () => {
    for (const blank of ["", "   ", "\n"]) {
      expect(() => unknown("not_recorded", blank)).toThrow(
        InvalidFactValueError,
      );
    }
    expect(() =>
      unknown("not_recorded", undefined as unknown as string),
    ).toThrow(InvalidFactValueError);
  });

  it("accepts every declared reason", () => {
    for (const reason of UNKNOWN_REASONS) {
      const fact = unknown(reason, `because of ${reason}`);
      expect(fact.reason).toBe(reason);
    }
  });

  it("recognises exactly the declared reasons at runtime", () => {
    for (const reason of UNKNOWN_REASONS) {
      expect(isUnknownReason(reason)).toBe(true);
    }
    for (const bad of ["", "unknown", "NOT_RECORDED", null, 0, {}]) {
      expect(isUnknownReason(bad)).toBe(false);
    }
  });

  it("carries a reason able to express propagated uncertainty", () => {
    // The mechanism by which an unknown prerequisite makes a dependent
    // fact unknown, rather than being absorbed.
    expect([...UNKNOWN_REASONS]).toContain("depends_on_unknown_fact");
  });
});

describe("the fact vocabulary is closed", () => {
  it("declares exactly the keys the rules consume", () => {
    expect([...FACT_KEYS]).toEqual([
      "circuit_under_investigation",
      "measurements_on_job",
      "measurements_on_circuit",
      "ai_hazard_categories",
    ]);
  });

  it("recognises only declared keys at runtime", () => {
    for (const key of FACT_KEYS) {
      expect(isFactKey(key)).toBe(true);
    }
    for (const bad of [
      "voltage_present",
      "isolation_verified",
      "circuit_under_investigation ",
      "",
      null,
      undefined,
      0,
      {},
    ]) {
      expect(isFactKey(bad)).toBe(false);
    }
  });

  it("has no key that presumes a safety conclusion", () => {
    const conclusive = /(safe|isolated|deenergi|de_energi|clear|ok|permitted)/i;
    for (const key of FACT_KEYS) {
      expect(key).not.toMatch(conclusive);
    }
  });

  it("a SafetyFacts value carries every key with no optional field", () => {
    const facts = factsWith();
    for (const key of FACT_KEYS) {
      expect(facts).toHaveProperty(key);
      expect(facts[key]).toBeDefined();
      expect(typeof facts[key].known).toBe("boolean");
    }
    expect(Object.keys(facts).sort()).toEqual([...FACT_KEYS].sort());
  });
});

describe("fact-set helpers report, they do not judge", () => {
  it("allFactsKnown is true only when every fact is Known", () => {
    expect(allFactsKnown(factsWith())).toBe(true);
    expect(
      allFactsKnown(
        factsWith({
          measurements_on_circuit: unknown(
            "depends_on_unknown_fact",
            "circuit not identified",
          ),
        }),
      ),
    ).toBe(false);
  });

  it("unknownFactKeys lists the gaps in declared order, deterministically", () => {
    const facts = factsWith({
      circuit_under_investigation: unknown("ambiguous", "three circuits"),
      measurements_on_circuit: unknown("depends_on_unknown_fact", "no circuit"),
    });
    const first = unknownFactKeys(facts);
    expect(first).toEqual([
      "circuit_under_investigation",
      "measurements_on_circuit",
    ]);
    for (let i = 0; i < 10; i += 1) {
      expect(unknownFactKeys(facts)).toEqual(first);
    }
  });

  it("unknownFactKeys is empty when everything is Known", () => {
    expect(unknownFactKeys(factsWith())).toEqual([]);
  });

  it("neither helper returns anything resembling a safety state", () => {
    const result = [
      allFactsKnown(factsWith()),
      ...unknownFactKeys(factsWith()),
    ];
    for (const value of result) {
      expect(value).not.toBe("STOP");
      expect(value).not.toBe("INSUFFICIENT_INFORMATION");
      expect(value).not.toBe("PROCEED_WITH_PRECAUTIONS");
    }
  });
});

describe("determinism and serializability", () => {
  it("a Known fact round-trips through JSON unchanged", () => {
    const fact = known(measurement);
    expect(JSON.parse(JSON.stringify(fact))).toEqual(fact);
  });

  it("an Unknown fact round-trips through JSON with its reason and detail", () => {
    const fact = unknown("ambiguous", "measurements reference three circuits");
    const roundTripped = JSON.parse(JSON.stringify(fact));
    expect(roundTripped).toEqual(fact);
    expect(roundTripped.known).toBe(false);
    expect(roundTripped.reason).toBe("ambiguous");
    expect(roundTripped.detail).toBe("measurements reference three circuits");
  });

  it("a whole SafetyFacts value round-trips, preserving the Known/Unknown split", () => {
    const facts = factsWith({
      measurements_on_circuit: unknown("depends_on_unknown_fact", "no circuit"),
    });
    const roundTripped = JSON.parse(JSON.stringify(facts)) as SafetyFacts;
    expect(roundTripped).toEqual(facts);
    expect(isKnown(roundTripped.measurements_on_job)).toBe(true);
    expect(isUnknown(roundTripped.measurements_on_circuit)).toBe(true);
  });

  it("uses plain data, not class instances or symbol discriminants", () => {
    const k = known(1);
    const u = unknown("not_recorded", "nothing");
    expect(Object.getPrototypeOf(k)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(u)).toBe(Object.prototype);
    expect(Object.getOwnPropertySymbols(k)).toHaveLength(0);
    expect(Object.getOwnPropertySymbols(u)).toHaveLength(0);
  });

  it("identical inputs produce identical facts", () => {
    expect(known(7)).toEqual(known(7));
    expect(unknown("not_recorded", "x")).toEqual(unknown("not_recorded", "x"));
    expect(unknown("not_recorded", "x")).not.toEqual(
      unknown("ambiguous", "x"),
    );
  });

  it("does not mutate the value it is given", () => {
    const measurements = [measurement];
    const snapshot = JSON.parse(JSON.stringify(measurements));
    const fact = known(measurements);
    unwrapKnown(fact);
    expect(measurements).toEqual(snapshot);
  });
});

describe("architectural boundaries", () => {
  // Read the source directly: these are the constraints that make the
  // module safe to reason about, and a stray import would silently
  // violate them without failing any behavioural test.
  //
  // Scanned with comments stripped, so the module stays free to *discuss*
  // the boundaries it upholds ("this file references no SafetyState")
  // without its own prose tripping the check.
  const source = readFileSync(
    resolve(process.cwd(), "lib/safety/facts.ts"),
    "utf8",
  );
  const code = source.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, "");

  it("does not import Prisma, a repository, a route, or the database", () => {
    expect(code).not.toMatch(/from\s+["']@\/lib\/db\//);
    expect(code).not.toMatch(/from\s+["']@\/lib\/generated\//);
    expect(code).not.toMatch(/@prisma\//);
    expect(code).not.toMatch(/\bPrismaClient\b/);
    expect(code).not.toMatch(/repositor/i);
  });

  it("does not import or reference the safety state model", () => {
    // Facts describe the world; states judge it. This module must do
    // only the former.
    expect(code).not.toMatch(/from\s+["']@\/lib\/safety\/states["']/);
    expect(code).not.toMatch(/\bSafetyState\b/);
    expect(code).not.toMatch(/\bmaxState\b/);
    expect(code).not.toMatch(/\baggregateSafetyStates\b/);
  });

  it("produces no SafetyState value anywhere in the module", () => {
    expect(code).not.toMatch(/["']STOP["']/);
    expect(code).not.toMatch(/["']INSUFFICIENT_INFORMATION["']/);
    expect(code).not.toMatch(/["']PROCEED_WITH_PRECAUTIONS["']/);
  });

  it("evaluates no rules and contains no electrical thresholds", () => {
    expect(code).not.toMatch(/from\s+["']@\/lib\/safety\/rules/);
    expect(code).not.toMatch(/\bNEC\b|\bIEC\b|BS\s?7671/);
    // No bare numeric comparison against a magnitude -- the only numbers
    // in this module are inside type declarations.
    expect(code).not.toMatch(/value\s*[<>]=?\s*\d/);
  });

  it("contains no AI or model logic", () => {
    expect(code).not.toMatch(/anthropic/i);
    expect(code).not.toMatch(/from\s+["']@\/lib\/ai\//);
    expect(code).not.toMatch(/\bllm\b/i);
  });

  it("imports only pure, type-only vocabulary from sibling modules", () => {
    const importLines = code
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"));
    expect(importLines).toHaveLength(3);
    for (const line of importLines) {
      expect(line).toMatch(/^import type /);
    }
  });
});
