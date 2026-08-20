import { describe, expect, it } from "vitest";
import {
  SAFETY_STATES,
  STATE_PRECEDENCE,
  FLOOR_STATE,
  RULESET_VERSION,
  UnknownSafetyStateError,
  aggregateSafetyStates,
  isSafetyState,
  maxState,
  type SafetyState,
} from "@/lib/safety/states";

/** Every ordered array of states up to `maxLength`, including the empty
 * one -- used for the property-style checks below so they cover the whole
 * input space rather than a few hand-picked cases. */
function allStateSequences(maxLength: number): SafetyState[][] {
  const out: SafetyState[][] = [[]];
  let current: SafetyState[][] = [[]];
  for (let length = 1; length <= maxLength; length += 1) {
    const grown: SafetyState[][] = [];
    for (const sequence of current) {
      for (const state of SAFETY_STATES) {
        grown.push([...sequence, state]);
      }
    }
    out.push(...grown);
    current = grown;
  }
  return out;
}

describe("the state vocabulary", () => {
  it("contains exactly the three approved states", () => {
    expect([...SAFETY_STATES]).toEqual([
      "PROCEED_WITH_PRECAUTIONS",
      "INSUFFICIENT_INFORMATION",
      "STOP",
    ]);
  });

  it("ranks every state, with no gaps and no duplicates", () => {
    for (const state of SAFETY_STATES) {
      expect(STATE_PRECEDENCE[state]).toBeTypeOf("number");
    }
    const ranks = SAFETY_STATES.map((s) => STATE_PRECEDENCE[s]);
    expect(new Set(ranks).size).toBe(SAFETY_STATES.length);
    expect(Object.keys(STATE_PRECEDENCE).sort()).toEqual(
      [...SAFETY_STATES].sort(),
    );
  });

  it("exposes a ruleset version so a verdict can be interpreted later", () => {
    expect(RULESET_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("recognises exactly the declared states at runtime", () => {
    for (const state of SAFETY_STATES) {
      expect(isSafetyState(state)).toBe(true);
    }
    for (const notAState of [
      "SAFE",
      "stop",
      "",
      null,
      undefined,
      0,
      {},
      ["STOP"],
    ]) {
      expect(isSafetyState(notAState)).toBe(false);
    }
  });
});

describe("no permissive state exists", () => {
  // This is the invariant that makes the whole engine honest: TradeAI
  // cannot inspect a physical installation, so it must have no vocabulary
  // for declaring one safe. A future edit that adds such a state should
  // fail here first.
  it("has no SAFE / ALL_CLEAR / PASS-equivalent member", () => {
    const permissive =
      /^(safe|all[_ -]?clear|pass(ed)?|ok(ay)?|clear|fine|good|no[_ -]?risk|permitted|allowed)$/i;
    for (const state of SAFETY_STATES) {
      expect(state).not.toMatch(permissive);
    }
  });

  it("the least restrictive state still names precautions", () => {
    expect(FLOOR_STATE).toBe("PROCEED_WITH_PRECAUTIONS");
    expect(FLOOR_STATE).toMatch(/PRECAUTIONS/);
  });

  it("the floor is genuinely the lowest rank, and STOP the highest", () => {
    const ranks = SAFETY_STATES.map((s) => STATE_PRECEDENCE[s]);
    expect(STATE_PRECEDENCE[FLOOR_STATE]).toBe(Math.min(...ranks));
    expect(STATE_PRECEDENCE.STOP).toBe(Math.max(...ranks));
  });
});

describe("precedence", () => {
  it("STOP dominates every state, in both argument orders", () => {
    for (const state of SAFETY_STATES) {
      expect(maxState("STOP", state)).toBe("STOP");
      expect(maxState(state, "STOP")).toBe("STOP");
    }
  });

  it("INSUFFICIENT_INFORMATION dominates PROCEED_WITH_PRECAUTIONS", () => {
    expect(
      maxState("INSUFFICIENT_INFORMATION", "PROCEED_WITH_PRECAUTIONS"),
    ).toBe("INSUFFICIENT_INFORMATION");
    expect(
      maxState("PROCEED_WITH_PRECAUTIONS", "INSUFFICIENT_INFORMATION"),
    ).toBe("INSUFFICIENT_INFORMATION");
  });

  it("INSUFFICIENT_INFORMATION does not dominate STOP", () => {
    // An unknown must never talk the system down from an identified
    // hazard.
    expect(maxState("INSUFFICIENT_INFORMATION", "STOP")).toBe("STOP");
  });

  it("orders strictly: PROCEED < INSUFFICIENT < STOP", () => {
    expect(STATE_PRECEDENCE.PROCEED_WITH_PRECAUTIONS).toBeLessThan(
      STATE_PRECEDENCE.INSUFFICIENT_INFORMATION,
    );
    expect(STATE_PRECEDENCE.INSUFFICIENT_INFORMATION).toBeLessThan(
      STATE_PRECEDENCE.STOP,
    );
  });
});

describe("maxState is a well-behaved lattice join", () => {
  it("is idempotent: combining a state with itself returns it unchanged", () => {
    for (const state of SAFETY_STATES) {
      expect(maxState(state, state)).toBe(state);
    }
  });

  it("is commutative for every pair", () => {
    for (const a of SAFETY_STATES) {
      for (const b of SAFETY_STATES) {
        expect(maxState(a, b)).toBe(maxState(b, a));
      }
    }
  });

  it("is associative for every triple", () => {
    for (const a of SAFETY_STATES) {
      for (const b of SAFETY_STATES) {
        for (const c of SAFETY_STATES) {
          expect(maxState(maxState(a, b), c)).toBe(maxState(a, maxState(b, c)));
        }
      }
    }
  });

  it("never returns a state less restrictive than either input", () => {
    for (const a of SAFETY_STATES) {
      for (const b of SAFETY_STATES) {
        const result = STATE_PRECEDENCE[maxState(a, b)];
        expect(result).toBeGreaterThanOrEqual(STATE_PRECEDENCE[a]);
        expect(result).toBeGreaterThanOrEqual(STATE_PRECEDENCE[b]);
      }
    }
  });
});

describe("aggregation", () => {
  it("returns the floor for an empty input, explicitly", () => {
    // Nothing raised anything, so there is nothing to escalate. Note this
    // is NOT the same as an unknown fact, which escalates once rules
    // exist -- see the note on aggregateSafetyStates.
    expect(aggregateSafetyStates([])).toBe(FLOOR_STATE);
    expect(aggregateSafetyStates([])).toBe("PROCEED_WITH_PRECAUTIONS");
  });

  it("returns the single input when given exactly one state", () => {
    for (const state of SAFETY_STATES) {
      expect(aggregateSafetyStates([state])).toBe(state);
    }
  });

  it("is deterministic when aggregating identical states", () => {
    for (const state of SAFETY_STATES) {
      expect(aggregateSafetyStates([state, state])).toBe(state);
      expect(aggregateSafetyStates([state, state, state, state])).toBe(state);
    }
  });

  it("equals the maximum of its inputs for every sequence up to length 3", () => {
    for (const sequence of allStateSequences(3)) {
      const expected = sequence.reduce<SafetyState>(maxState, FLOOR_STATE);
      expect(aggregateSafetyStates(sequence)).toBe(expected);
    }
  });

  it("can never lower the state: the result dominates every input", () => {
    // The ratchet property, stated directly. This is the generalisation
    // of the additive-only guarantee in lib/ai/safetyRules.ts.
    for (const sequence of allStateSequences(3)) {
      const resultRank = STATE_PRECEDENCE[aggregateSafetyStates(sequence)];
      for (const input of sequence) {
        expect(resultRank).toBeGreaterThanOrEqual(STATE_PRECEDENCE[input]);
      }
      expect(resultRank).toBeGreaterThanOrEqual(STATE_PRECEDENCE[FLOOR_STATE]);
    }
  });

  it("is monotonic: appending a state never lowers the result", () => {
    for (const sequence of allStateSequences(2)) {
      const before = STATE_PRECEDENCE[aggregateSafetyStates(sequence)];
      for (const extra of SAFETY_STATES) {
        const after =
          STATE_PRECEDENCE[aggregateSafetyStates([...sequence, extra])];
        expect(after).toBeGreaterThanOrEqual(before);
      }
    }
  });

  it("is order-independent: any permutation yields the same verdict", () => {
    const permutations: SafetyState[][] = [
      ["STOP", "INSUFFICIENT_INFORMATION", "PROCEED_WITH_PRECAUTIONS"],
      ["STOP", "PROCEED_WITH_PRECAUTIONS", "INSUFFICIENT_INFORMATION"],
      ["INSUFFICIENT_INFORMATION", "STOP", "PROCEED_WITH_PRECAUTIONS"],
      ["INSUFFICIENT_INFORMATION", "PROCEED_WITH_PRECAUTIONS", "STOP"],
      ["PROCEED_WITH_PRECAUTIONS", "STOP", "INSUFFICIENT_INFORMATION"],
      ["PROCEED_WITH_PRECAUTIONS", "INSUFFICIENT_INFORMATION", "STOP"],
    ];
    for (const permutation of permutations) {
      expect(aggregateSafetyStates(permutation)).toBe("STOP");
    }
  });

  it("a single STOP anywhere in a long input dominates the result", () => {
    // Deterministically alternated rather than randomised -- this suite
    // asserts determinism, so its own inputs should not vary per run.
    const many: SafetyState[] = Array.from({ length: 50 }, (_unused, index) =>
      index % 2 === 0
        ? "PROCEED_WITH_PRECAUTIONS"
        : "INSUFFICIENT_INFORMATION",
    );
    expect(aggregateSafetyStates([...many, "STOP"])).toBe("STOP");
    expect(aggregateSafetyStates(["STOP", ...many])).toBe("STOP");
    expect(
      aggregateSafetyStates([
        ...many.slice(0, 25),
        "STOP",
        ...many.slice(25),
      ]),
    ).toBe("STOP");
  });

  it("does not mutate its input", () => {
    const input: SafetyState[] = [
      "PROCEED_WITH_PRECAUTIONS",
      "STOP",
      "INSUFFICIENT_INFORMATION",
    ];
    const snapshot = [...input];
    aggregateSafetyStates(input);
    expect(input).toEqual(snapshot);
  });
});

describe("invalid input", () => {
  // TypeScript prevents these at compile time; the casts below simulate a
  // value crossing a type boundary (a JSON payload, a deserializer, a
  // future caller in untyped code).
  const notAState = "SAFE" as unknown as SafetyState;

  it("maxState throws rather than coercing an unrecognised value", () => {
    expect(() => maxState(notAState, "STOP")).toThrow(UnknownSafetyStateError);
    expect(() => maxState("STOP", notAState)).toThrow(UnknownSafetyStateError);
  });

  it("aggregateSafetyStates throws rather than silently dropping the value", () => {
    // Silently ignoring it could discard a STOP; silently promoting it to
    // STOP would raise a false alarm from a programming bug. Failing
    // loudly is the only option that misleads nobody.
    expect(() => aggregateSafetyStates([notAState])).toThrow(
      UnknownSafetyStateError,
    );
    expect(() => aggregateSafetyStates(["STOP", notAState])).toThrow(
      UnknownSafetyStateError,
    );
  });

  it("throws for null, undefined and non-string values too", () => {
    for (const bad of [null, undefined, 3, {}, []]) {
      expect(() =>
        aggregateSafetyStates([bad as unknown as SafetyState]),
      ).toThrow(UnknownSafetyStateError);
    }
  });

  it("names the offending value in the error", () => {
    expect(() => maxState(notAState, "STOP")).toThrow(/SAFE/);
  });
});

describe("determinism", () => {
  it("identical inputs always produce identical outputs", () => {
    for (const sequence of allStateSequences(3)) {
      const first = aggregateSafetyStates(sequence);
      for (let i = 0; i < 25; i += 1) {
        expect(aggregateSafetyStates([...sequence])).toBe(first);
      }
    }
  });

  it("does not depend on the clock", async () => {
    const sequence: SafetyState[] = [
      "PROCEED_WITH_PRECAUTIONS",
      "INSUFFICIENT_INFORMATION",
    ];
    const before = aggregateSafetyStates(sequence);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(aggregateSafetyStates(sequence)).toBe(before);
  });
});

describe("no downgrade path exists", () => {
  // The guarantee is structural: the module exports no operation that
  // accepts a state and returns a less restrictive one, so no caller --
  // including a future AI layer -- has anything to call to talk the
  // system down from STOP.
  it("exports no minimising or clearing combinator", async () => {
    const moduleExports = await import("@/lib/safety/states");
    const suspicious = /^(min|lower|downgrade|clear|reset|relax|reduce|allow)/i;
    for (const name of Object.keys(moduleExports)) {
      expect(name).not.toMatch(suspicious);
    }
  });

  it("no sequence of aggregations can reach a lower state than one already held", () => {
    // Once STOP is in the fold, nothing appended afterwards recovers a
    // lower state.
    let held: SafetyState = "STOP";
    for (const state of SAFETY_STATES) {
      held = maxState(held, state);
      expect(held).toBe("STOP");
    }
  });
});
