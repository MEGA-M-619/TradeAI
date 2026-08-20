import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TenantTxClient } from "@/lib/db/tenantContext";
import { buildSafetyFacts } from "@/lib/safety/factBuilder";
import { isKnown, isUnknown, unwrapKnown } from "@/lib/safety/facts";
import { evaluateSafety } from "@/lib/safety/evaluate";

/**
 * These tests drive the real repository functions through a fake
 * transaction client, so the org-scoping predicates the repositories
 * actually write are exercised rather than stubbed out. The fake behaves
 * like a tiny relational store: it applies the `where` clause it is
 * given, which is what lets the tenant-isolation assertions below mean
 * something without a live database.
 */

const ORG = "org-a";
const OTHER_ORG = "org-b";
const JOB = "job-1";
const SESSION = "session-1";
const CUSTOMER = "customer-1";
const CIRCUIT = "circuit-1";
const OTHER_CIRCUIT = "circuit-2";

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    return row[key] === expected;
  });
}

type Store = {
  diagnosticSessions: Row[];
  jobs: Row[];
  measurements: Row[];
  circuits: Row[];
  /** Rows carry their `findings` inline. The fake ignores Prisma's
   * `include`, and returning the row as-is is enough because the builder
   * only reads `findings[].safetyCategories` and `findings[].verdict`. */
  aiAssessments: Row[];
};

/** Records every table touched, so a test can assert the builder never
 * reached for something it should not. */
const touched: string[] = [];

function fakeTx(store: Store): TenantTxClient {
  const model = (name: keyof Store) => ({
    findFirst: async ({ where }: { where: Row }) => {
      touched.push(name);
      return store[name].find((row) => matches(row, where)) ?? null;
    },
    findMany: async ({ where }: { where: Row }) => {
      touched.push(name);
      return store[name].filter((row) => matches(row, where));
    },
  });
  return {
    diagnosticSession: model("diagnosticSessions"),
    job: model("jobs"),
    measurement: model("measurements"),
    circuit: model("circuits"),
    aiAssessment: model("aiAssessments"),
  } as unknown as TenantTxClient;
}

function measurementRow(overrides: Row & { id: string }): Row {
  return {
    organizationId: ORG,
    jobId: JOB,
    circuitId: CIRCUIT,
    testType: "voltage_ac",
    value: 120,
    unit: "V",
    expectedMin: 114,
    expectedMax: 126,
    result: "pass",
    recordedAt: new Date("2026-08-19T12:00:00.000Z"),
    ...overrides,
  };
}

function store(overrides: Partial<Store> = {}): Store {
  return {
    diagnosticSessions: [
      { id: SESSION, organizationId: ORG, jobId: JOB, symptom: "trips" },
    ],
    jobs: [{ id: JOB, organizationId: ORG, customerId: CUSTOMER }],
    circuits: [
      {
        id: CIRCUIT,
        organizationId: ORG,
        customerId: CUSTOMER,
        label: "Kitchen ring",
      },
      {
        id: OTHER_CIRCUIT,
        organizationId: ORG,
        customerId: CUSTOMER,
        label: "Bathroom",
      },
    ],
    measurements: [measurementRow({ id: "m-1" })],
    aiAssessments: [],
    ...overrides,
  };
}

/** An assessment row as `listForJob`/`getFullById` would return it, with
 * findings inline. `listForJob` orders by version desc, which the fake
 * does not do -- fixtures list rows newest-first to match. */
function assessmentRow(
  overrides: Row & { id: string; version: number },
): Row {
  return {
    organizationId: ORG,
    jobId: JOB,
    status: "complete",
    findings: [],
    ...overrides,
  };
}

function finding(
  safetyCategories: string[],
  verdict: string | null = null,
): Row {
  return {
    safetyCategories,
    verdict: verdict ? { verdict } : null,
  };
}

const build = (s: Store, orgId = ORG, jobId = JOB, sessionId = SESSION) =>
  buildSafetyFacts(fakeTx(s), orgId, jobId, sessionId);

// --- happy path -------------------------------------------------------

describe("deterministic fact construction", () => {
  it("builds all three facts as Known when the data supports it", async () => {
    const facts = await build(store());
    expect(isKnown(facts.circuit_under_investigation)).toBe(true);
    expect(isKnown(facts.measurements_on_job)).toBe(true);
    expect(isKnown(facts.measurements_on_circuit)).toBe(true);
    expect(unwrapKnown(facts.circuit_under_investigation)).toEqual({
      circuitId: CIRCUIT,
      label: "Kitchen ring",
    });
  });

  it("maps a measurement row onto the safety projection exactly", async () => {
    const facts = await build(store());
    const [measurement] = unwrapKnown(facts.measurements_on_job);
    expect(measurement).toEqual({
      measurementId: "m-1",
      testType: "voltage_ac",
      circuitId: CIRCUIT,
      value: 120,
      unit: "V",
      result: "pass",
      criterion: {
        source: "technician_supplied",
        expectedMin: 114,
        expectedMax: 126,
      },
      recordedAt: "2026-08-19T12:00:00.000Z",
    });
  });

  it("identical persisted inputs always produce identical facts", async () => {
    const first = JSON.stringify(await build(store()));
    for (let i = 0; i < 15; i += 1) {
      expect(JSON.stringify(await build(store()))).toBe(first);
    }
  });

  it("orders measurements by (recordedAt, id), breaking timestamp ties stably", async () => {
    const sameInstant = new Date("2026-08-19T12:00:00.000Z");
    const shuffled = store({
      measurements: [
        measurementRow({ id: "m-c", recordedAt: sameInstant }),
        measurementRow({ id: "m-a", recordedAt: sameInstant }),
        measurementRow({ id: "m-b", recordedAt: sameInstant }),
        measurementRow({
          id: "m-earlier",
          recordedAt: new Date("2026-08-19T08:00:00.000Z"),
        }),
      ],
    });
    const facts = await build(shuffled);
    expect(
      unwrapKnown(facts.measurements_on_job).map((m) => m.measurementId),
    ).toEqual(["m-earlier", "m-a", "m-b", "m-c"]);
  });
});

// --- unknowns ---------------------------------------------------------

describe("missing and unknown facts", () => {
  it("returns every fact Unknown when the session cannot be read", async () => {
    const facts = await build(store({ diagnosticSessions: [] }));
    expect(isUnknown(facts.circuit_under_investigation)).toBe(true);
    expect(isUnknown(facts.measurements_on_job)).toBe(true);
    expect(isUnknown(facts.measurements_on_circuit)).toBe(true);
  });

  it("returns every fact Unknown when the session belongs to another job", async () => {
    const facts = await build(store(), ORG, "job-other", SESSION);
    expect(isUnknown(facts.measurements_on_job)).toBe(true);
  });

  it("returns every fact Unknown when the job cannot be read", async () => {
    const facts = await build(store({ jobs: [] }));
    expect(isUnknown(facts.measurements_on_job)).toBe(true);
  });

  it("never defaults an Unknown into an empty list", async () => {
    // The distinction that matters: "we could not read it" is not "there
    // are none".
    const unreadable = await build(store({ diagnosticSessions: [] }));
    const genuinelyEmpty = await build(store({ measurements: [] }));
    expect(isUnknown(unreadable.measurements_on_job)).toBe(true);
    expect(isKnown(genuinelyEmpty.measurements_on_job)).toBe(true);
    expect(unwrapKnown(genuinelyEmpty.measurements_on_job)).toEqual([]);
  });

  it("carries a non-empty reason and detail on every Unknown", async () => {
    const facts = await build(store({ diagnosticSessions: [] }));
    // Checked one key at a time rather than by looping over a FactKey
    // union: indexing SafetyFacts with the union yields differently
    // parameterised Fact types that the generic guard cannot unify.
    const each = [
      facts.circuit_under_investigation,
      facts.measurements_on_job,
      facts.measurements_on_circuit,
    ];
    for (const fact of each) {
      if (fact.known) throw new Error("expected every fact to be Unknown");
      expect(fact.reason.length).toBeGreaterThan(0);
      expect(fact.detail.trim().length).toBeGreaterThan(0);
    }
  });
});

// --- circuit identification ------------------------------------------

describe("circuit identification", () => {
  it("is not_recorded when no measurement references a circuit", async () => {
    const facts = await build(
      store({ measurements: [measurementRow({ id: "m-1", circuitId: null })] }),
    );
    const circuit = facts.circuit_under_investigation;
    if (!isUnknown(circuit)) throw new Error("expected Unknown");
    expect(circuit.reason).toBe("not_recorded");
    expect(isUnknown(facts.measurements_on_circuit)).toBe(true);
    // The job-level measurements are still a fact.
    expect(isKnown(facts.measurements_on_job)).toBe(true);
  });

  it("is ambiguous when measurements reference several circuits", async () => {
    const facts = await build(
      store({
        measurements: [
          measurementRow({ id: "m-1", circuitId: CIRCUIT }),
          measurementRow({ id: "m-2", circuitId: OTHER_CIRCUIT }),
        ],
      }),
    );
    const circuit = facts.circuit_under_investigation;
    if (!isUnknown(circuit)) throw new Error("expected Unknown");
    expect(circuit.reason).toBe("ambiguous");
    expect(circuit.detail).toMatch(/2 different circuits/);
  });

  it("propagates the unknown circuit into measurements_on_circuit", async () => {
    const facts = await build(
      store({
        measurements: [
          measurementRow({ id: "m-1", circuitId: CIRCUIT }),
          measurementRow({ id: "m-2", circuitId: OTHER_CIRCUIT }),
        ],
      }),
    );
    const onCircuit = facts.measurements_on_circuit;
    if (!isUnknown(onCircuit)) throw new Error("expected Unknown");
    expect(onCircuit.reason).toBe("depends_on_unknown_fact");
  });

  it("is not_recorded when the referenced circuit is not readable for this customer", async () => {
    const facts = await build(store({ circuits: [] }));
    const circuit = facts.circuit_under_investigation;
    if (!isUnknown(circuit)) throw new Error("expected Unknown");
    expect(circuit.reason).toBe("not_recorded");
  });

  it("ignores unattributed readings when a single circuit is referenced", async () => {
    const facts = await build(
      store({
        measurements: [
          measurementRow({ id: "m-1", circuitId: CIRCUIT }),
          measurementRow({ id: "m-2", circuitId: null }),
        ],
      }),
    );
    expect(isKnown(facts.circuit_under_investigation)).toBe(true);
    expect(
      unwrapKnown(facts.measurements_on_circuit).map((m) => m.measurementId),
    ).toEqual(["m-1"]);
  });
});

// --- job vs circuit scope --------------------------------------------

describe("measurements on job versus on circuit", () => {
  it("separates the two, keeping unattributed readings out of the circuit set", async () => {
    const facts = await build(
      store({
        measurements: [
          measurementRow({ id: "m-1", circuitId: CIRCUIT }),
          measurementRow({ id: "m-2", circuitId: null }),
          measurementRow({ id: "m-3", circuitId: CIRCUIT }),
        ],
      }),
    );
    expect(
      unwrapKnown(facts.measurements_on_job).map((m) => m.measurementId),
    ).toEqual(["m-1", "m-2", "m-3"]);
    expect(
      unwrapKnown(facts.measurements_on_circuit).map((m) => m.measurementId),
    ).toEqual(["m-1", "m-3"]);
  });

  it("never includes another job's measurements", async () => {
    const facts = await build(
      store({
        measurements: [
          measurementRow({ id: "mine", jobId: JOB }),
          measurementRow({ id: "theirs", jobId: "job-other" }),
        ],
      }),
    );
    const ids = unwrapKnown(facts.measurements_on_job).map(
      (m) => m.measurementId,
    );
    expect(ids).toEqual(["mine"]);
    expect(ids).not.toContain("theirs");
  });
});

// --- measurement projection ------------------------------------------

describe("measurement projection", () => {
  it("passes a null result through untouched", async () => {
    const facts = await build(
      store({ measurements: [measurementRow({ id: "m-1", result: null })] }),
    );
    expect(unwrapKnown(facts.measurements_on_job)[0].result).toBeNull();
  });

  it("preserves contradictory results rather than resolving them", async () => {
    const facts = await build(
      store({
        measurements: [
          measurementRow({ id: "m-1", result: "pass" }),
          measurementRow({ id: "m-2", result: "fail" }),
        ],
      }),
    );
    expect(
      unwrapKnown(facts.measurements_on_job).map((m) => m.result),
    ).toEqual(["pass", "fail"]);
    // And the evaluator escalates on them.
    expect(evaluateSafety(facts).state).toBe("INSUFFICIENT_INFORMATION");
  });

  it("marks a technician-supplied range as an unverified criterion", async () => {
    const facts = await build(store());
    expect(unwrapKnown(facts.measurements_on_job)[0].criterion).toEqual({
      source: "technician_supplied",
      expectedMin: 114,
      expectedMax: 126,
    });
  });

  it("reports no criterion when neither bound was supplied", async () => {
    const facts = await build(
      store({
        measurements: [
          measurementRow({
            id: "m-1",
            expectedMin: null,
            expectedMax: null,
            result: "not_applicable",
          }),
        ],
      }),
    );
    expect(unwrapKnown(facts.measurements_on_job)[0].criterion).toEqual({
      source: "none",
    });
  });

  it("treats a half-open range as still technician-supplied", async () => {
    const facts = await build(
      store({
        measurements: [
          measurementRow({ id: "m-1", expectedMin: 1, expectedMax: null }),
        ],
      }),
    );
    expect(unwrapKnown(facts.measurements_on_job)[0].criterion).toEqual({
      source: "technician_supplied",
      expectedMin: 1,
      expectedMax: null,
    });
  });

  it("never produces a verified criterion, because none exists", async () => {
    const facts = await build(store());
    for (const measurement of unwrapKnown(facts.measurements_on_job)) {
      expect(measurement.criterion.source).not.toBe("verified_standard");
      expect(["technician_supplied", "none"]).toContain(
        measurement.criterion.source,
      );
    }
  });
});

// --- tenant isolation -------------------------------------------------

describe("tenant isolation assumptions", () => {
  it("a forged org context reads nothing and fails closed to all-Unknown", async () => {
    // The repositories scope every query by organizationId; org B asking
    // for org A's session matches no row.
    const facts = await build(store(), OTHER_ORG);
    expect(isUnknown(facts.circuit_under_investigation)).toBe(true);
    expect(isUnknown(facts.measurements_on_job)).toBe(true);
    expect(isUnknown(facts.measurements_on_circuit)).toBe(true);
  });

  it("a forged org context escalates rather than looking clean", async () => {
    // The failure mode that matters: an unreadable session must never
    // evaluate like a session with nothing wrong with it.
    const forged = evaluateSafety(await build(store(), OTHER_ORG));
    const legitimate = evaluateSafety(await build(store()));
    expect(forged.state).toBe("INSUFFICIENT_INFORMATION");
    expect(legitimate.state).not.toBe(forged.state);
  });

  it("cross-org measurements never enter the facts", async () => {
    const facts = await build(
      store({
        measurements: [
          measurementRow({ id: "mine", organizationId: ORG }),
          measurementRow({ id: "theirs", organizationId: OTHER_ORG }),
        ],
      }),
    );
    const ids = unwrapKnown(facts.measurements_on_job).map(
      (m) => m.measurementId,
    );
    expect(ids).toEqual(["mine"]);
  });

  it("a circuit belonging to another customer is not adopted", async () => {
    const facts = await build(
      store({
        circuits: [
          {
            id: CIRCUIT,
            organizationId: ORG,
            customerId: "customer-other",
            label: "Someone else's",
          },
        ],
      }),
    );
    expect(isUnknown(facts.circuit_under_investigation)).toBe(true);
  });

  it("reads only the expected tables", async () => {
    // A deliberate ceiling on the builder's read surface: widening it is
    // a decision, not something that should happen quietly.
    touched.length = 0;
    await build(store());
    expect(new Set(touched)).toEqual(
      new Set([
        "diagnosticSessions",
        "jobs",
        "measurements",
        "circuits",
        "aiAssessments",
      ]),
    );
  });
});

// --- AI hazard categories --------------------------------------------

describe("ai_hazard_categories", () => {
  it("is Known([]) when the job has no assessment at all", async () => {
    // The critical case: absence of an assessment is a fact, not an
    // unknown. Treating it as Unknown would escalate every
    // measurement-only job, since an Unknown required fact escalates.
    const facts = await build(store());
    expect(isKnown(facts.ai_hazard_categories)).toBe(true);
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([]);
  });

  it("is Known([]) when the completed assessment flagged nothing", async () => {
    const facts = await build(
      store({
        aiAssessments: [
          assessmentRow({ id: "a-1", version: 1, findings: [finding([])] }),
        ],
      }),
    );
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([]);
  });

  it("carries the categories a completed assessment flagged", async () => {
    const facts = await build(
      store({
        aiAssessments: [
          assessmentRow({
            id: "a-1",
            version: 1,
            findings: [
              finding(["arc_fault_suspected"]),
              finding(["thermal_damage_scorching", "arc_fault_suspected"]),
            ],
          }),
        ],
      }),
    );
    // De-duplicated and sorted, so identical data yields an identical set.
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([
      "arc_fault_suspected",
      "thermal_damage_scorching",
    ]);
  });

  it("excludes a finding the technician rejected", async () => {
    const facts = await build(
      store({
        aiAssessments: [
          assessmentRow({
            id: "a-1",
            version: 1,
            findings: [
              finding(["arc_fault_suspected"], "rejected"),
              finding(["missing_bonding_or_grounding"]),
            ],
          }),
        ],
      }),
    );
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([
      "missing_bonding_or_grounding",
    ]);
  });

  it("keeps findings the technician confirmed, amended or left unresolved", async () => {
    for (const verdict of ["confirmed", "amended", "unresolved"]) {
      const facts = await build(
        store({
          aiAssessments: [
            assessmentRow({
              id: "a-1",
              version: 1,
              findings: [finding(["arc_fault_suspected"], verdict)],
            }),
          ],
        }),
      );
      expect(unwrapKnown(facts.ai_hazard_categories), verdict).toEqual([
        "arc_fault_suspected",
      ]);
    }
  });

  it("uses the latest complete assessment, not an older one", async () => {
    const facts = await build(
      store({
        aiAssessments: [
          assessmentRow({
            id: "a-2",
            version: 2,
            findings: [finding(["water_ingress_energized"])],
          }),
          assessmentRow({
            id: "a-1",
            version: 1,
            findings: [finding(["arc_fault_suspected"])],
          }),
        ],
      }),
    );
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([
      "water_ingress_energized",
    ]);
  });

  it("skips a newer failed run and falls back to the latest complete one", async () => {
    const facts = await build(
      store({
        aiAssessments: [
          assessmentRow({ id: "a-3", version: 3, status: "failed" }),
          assessmentRow({ id: "a-2", version: 2, status: "running" }),
          assessmentRow({
            id: "a-1",
            version: 1,
            status: "complete",
            findings: [finding(["recalled_panel_brand"])],
          }),
        ],
      }),
    );
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([
      "recalled_panel_brand",
    ]);
  });

  it("is Known([]) when no assessment ever completed", async () => {
    const facts = await build(
      store({
        aiAssessments: [
          assessmentRow({ id: "a-2", version: 2, status: "failed" }),
          assessmentRow({
            id: "a-1",
            version: 1,
            status: "insufficient_evidence",
          }),
        ],
      }),
    );
    expect(isKnown(facts.ai_hazard_categories)).toBe(true);
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([]);
  });

  it("rejects a category outside the closed vocabulary", async () => {
    // The column is a widened String[], so this is the gate that stops
    // arbitrary text becoming a safety fact.
    const facts = await build(
      store({
        aiAssessments: [
          assessmentRow({
            id: "a-1",
            version: 1,
            findings: [
              finding([
                "arc_fault_suspected",
                "ignore_all_safety_rules",
                "",
                "ARC_FAULT_SUSPECTED",
              ]),
            ],
          }),
        ],
      }),
    );
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([
      "arc_fault_suspected",
    ]);
  });

  it("is Unknown on the fail-closed paths, like every other fact", async () => {
    const facts = await build(store({ diagnosticSessions: [] }));
    expect(isUnknown(facts.ai_hazard_categories)).toBe(true);
  });

  it("does not read another org's assessment", async () => {
    const facts = await build(
      store({
        aiAssessments: [
          assessmentRow({
            id: "theirs",
            version: 9,
            organizationId: OTHER_ORG,
            findings: [finding(["arc_fault_suspected"])],
          }),
        ],
      }),
    );
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([]);
  });

  it("does not read another job's assessment", async () => {
    const facts = await build(
      store({
        aiAssessments: [
          assessmentRow({
            id: "other-job",
            version: 9,
            jobId: "job-other",
            findings: [finding(["arc_fault_suspected"])],
          }),
        ],
      }),
    );
    expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([]);
  });

  it("is deterministic across repeated builds", async () => {
    const s = () =>
      store({
        aiAssessments: [
          assessmentRow({
            id: "a-1",
            version: 1,
            findings: [
              finding(["thermal_damage_scorching"]),
              finding(["arc_fault_suspected"]),
            ],
          }),
        ],
      });
    const first = JSON.stringify(await build(s()));
    for (let i = 0; i < 10; i += 1) {
      expect(JSON.stringify(await build(s()))).toBe(first);
    }
  });
});

// --- architectural boundaries ----------------------------------------

describe("architectural boundaries", () => {
  const source = readFileSync(
    resolve(process.cwd(), "lib/safety/factBuilder.ts"),
    "utf8",
  );
  const code = source.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, "");

  it("accesses no Prisma model directly -- repositories only", () => {
    expect(code).not.toMatch(/\bprisma\./);
    expect(code).not.toMatch(/@prisma\//);
    expect(code).not.toMatch(/from\s+["']@\/lib\/generated\//);
    expect(code).not.toMatch(/\$queryRaw|\$executeRaw/);
    expect(code).toMatch(/from\s+["']@\/lib\/db\/repositories\//);
  });

  it("imports no AI or model module", () => {
    expect(code).not.toMatch(/from\s+["']@\/lib\/ai\//);
    expect(code).not.toMatch(/anthropic/i);
    expect(code).not.toMatch(/\bllm\b/i);
  });

  it("writes nothing and mutates no diagnostic state", () => {
    expect(code).not.toMatch(/\.create\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(code).not.toMatch(/withTenantContext/);
  });

  it("accepts no request input", () => {
    expect(code).not.toMatch(/\bRequest\b|\brequest\./);
    expect(code).not.toMatch(/searchParams|\.json\(\)|headers/);
  });

  it("produces no safety state, rule id, or verification item", () => {
    // Facts only. The evaluator decides everything else.
    expect(code).not.toMatch(/["']STOP["']/);
    expect(code).not.toMatch(/["']INSUFFICIENT_INFORMATION["']/);
    expect(code).not.toMatch(/["']PROCEED_WITH_PRECAUTIONS["']/);
    expect(code).not.toMatch(/from\s+["']@\/lib\/safety\/rules/);
    expect(code).not.toMatch(/from\s+["']@\/lib\/safety\/evaluate["']/);
  });

  it("contains no electrical threshold or standard reference", () => {
    expect(code).not.toMatch(/\bNEC\b|\bIEC\b|BS\s?7671|NFPA/);
    expect(code).not.toMatch(/\.value\s*[<>]=?/);
  });
});
