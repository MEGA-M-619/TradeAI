import { describe, expect, it } from "vitest";
import { buildAssessmentToolSchema } from "@/lib/ai/tool";
import { modelOutputSchema } from "@/lib/validation/assessment";

describe("buildAssessmentToolSchema", () => {
  it("produces a JSON Schema object type usable as a tool input_schema", () => {
    const schema = buildAssessmentToolSchema();
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    const props = schema.properties as Record<string, unknown>;
    expect(props.overallStatus).toBeDefined();
    expect(props.observations).toBeDefined();
    expect(props.hypotheses).toBeDefined();
    expect(props.followUpQuestions).toBeDefined();
    expect(props.limitations).toBeDefined();
  });

  it("is stable JSON (no functions, no undefined, round-trips through JSON.stringify)", () => {
    const schema = buildAssessmentToolSchema();
    expect(() => JSON.parse(JSON.stringify(schema))).not.toThrow();
  });

  it("a well-formed sample payload still passes the full Zod schema (business rules included)", () => {
    // The JSON Schema projection drops superRefine's cross-field rules --
    // this confirms modelOutputSchema itself (used at persistence time,
    // not just for the tool projection) still enforces them.
    const good = {
      overallStatus: "assessment_provided",
      observations: [
        {
          ref: "O1",
          statement: "A panel is visible.",
          citedEvidence: ["E1"],
          confidence: "high",
          rationale: "The panel is clearly visible in the frame.",
        },
      ],
      hypotheses: [],
      followUpQuestions: [],
      limitations: [],
    };
    expect(() => modelOutputSchema.parse(good)).not.toThrow();
  });

  it("rejects insufficient_evidence with populated findings (cross-field rule)", () => {
    const bad = {
      overallStatus: "insufficient_evidence",
      insufficientReason: "Not enough detail",
      observations: [
        {
          ref: "O1",
          statement: "x",
          citedEvidence: ["E1"],
          confidence: "low",
          rationale: "x",
        },
      ],
      hypotheses: [],
      followUpQuestions: [],
      limitations: [],
    };
    expect(() => modelOutputSchema.parse(bad)).toThrow();
  });

  it("rejects assessment_provided with zero findings (cross-field rule)", () => {
    const bad = {
      overallStatus: "assessment_provided",
      observations: [],
      hypotheses: [],
      followUpQuestions: [],
      limitations: [],
    };
    expect(() => modelOutputSchema.parse(bad)).toThrow();
  });

  it("rejects duplicate refs across observations and hypotheses", () => {
    const bad = {
      overallStatus: "assessment_provided",
      observations: [
        { ref: "O1", statement: "x", citedEvidence: ["E1"], confidence: "low", rationale: "x" },
      ],
      hypotheses: [
        {
          ref: "O1",
          statement: "x",
          citedEvidence: ["E1"],
          confidence: "low",
          rationale: "x",
          whatWouldChangeMyMind: "x",
          discriminatingTests: [{ test: "x", rulesInIfPositive: "x", rulesOutIfNegative: "x" }],
          safetyCategories: [],
        },
      ],
      followUpQuestions: [],
      limitations: [],
    };
    expect(() => modelOutputSchema.parse(bad)).toThrow();
  });

  it("rejects a hypothesis with no discriminating test", () => {
    const bad = {
      overallStatus: "assessment_provided",
      observations: [],
      hypotheses: [
        {
          ref: "H1",
          statement: "x",
          citedEvidence: ["E1"],
          confidence: "low",
          rationale: "x",
          whatWouldChangeMyMind: "x",
          discriminatingTests: [],
          safetyCategories: [],
        },
      ],
      followUpQuestions: [],
      limitations: [],
    };
    expect(() => modelOutputSchema.parse(bad)).toThrow();
  });

  it("rejects a hypothesis missing whatWouldChangeMyMind", () => {
    const bad = {
      overallStatus: "assessment_provided",
      observations: [],
      hypotheses: [
        {
          ref: "H1",
          statement: "x",
          citedEvidence: ["E1"],
          confidence: "low",
          rationale: "x",
          discriminatingTests: [{ test: "x", rulesInIfPositive: "x", rulesOutIfNegative: "x" }],
          safetyCategories: [],
        },
      ],
      followUpQuestions: [],
      limitations: [],
    };
    expect(() => modelOutputSchema.parse(bad)).toThrow();
  });

  it("rejects a finding with zero cited evidence", () => {
    const bad = {
      overallStatus: "assessment_provided",
      observations: [
        { ref: "O1", statement: "x", citedEvidence: [], confidence: "low", rationale: "x" },
      ],
      hypotheses: [],
      followUpQuestions: [],
      limitations: [],
    };
    expect(() => modelOutputSchema.parse(bad)).toThrow();
  });

  it("rejects an out-of-range evidence ref at the format layer", () => {
    const bad = {
      overallStatus: "assessment_provided",
      observations: [
        { ref: "O1", statement: "x", citedEvidence: ["E9"], confidence: "low", rationale: "x" },
      ],
      hypotheses: [],
      followUpQuestions: [],
      limitations: [],
    };
    expect(() => modelOutputSchema.parse(bad)).toThrow();
  });

  it("rejects a numeric confidence value", () => {
    const bad = {
      overallStatus: "assessment_provided",
      observations: [
        { ref: "O1", statement: "x", citedEvidence: ["E1"], confidence: 0.87, rationale: "x" },
      ],
      hypotheses: [],
      followUpQuestions: [],
      limitations: [],
    };
    expect(() => modelOutputSchema.parse(bad)).toThrow();
  });
});

/**
 * `limitations` is what the model says it could not determine. It has
 * always been part of modelOutputSchema and is now persisted and shown to
 * the technician, so these assert it goes through exactly the same
 * validation as every other field -- persisting it must not have opened a
 * path around the schema.
 */
describe("limitations", () => {
  const base = {
    overallStatus: "assessment_provided" as const,
    observations: [
      { ref: "O1", statement: "A panel is visible.", citedEvidence: ["E1"], confidence: "high", rationale: "Clearly in frame." },
    ],
    hypotheses: [],
    followUpQuestions: [],
  };

  it("is required -- a response omitting it is rejected, not defaulted to empty", () => {
    // The technician-facing consequence of defaulting instead of rejecting
    // would be an assessment that silently claims no limitations.
    expect(() => modelOutputSchema.parse({ ...base })).toThrow();
  });

  it("accepts an empty array (the model genuinely stated no limitations)", () => {
    const parsed = modelOutputSchema.parse({ ...base, limitations: [] });
    expect(parsed.limitations).toEqual([]);
  });

  it("accepts and preserves the order of stated limitations", () => {
    const limitations = ["The neutral bar is out of frame", "The panel label is illegible"];
    const parsed = modelOutputSchema.parse({ ...base, limitations });
    expect(parsed.limitations).toEqual(limitations);
  });

  it("is carried on the insufficient_evidence path too, where findings must be empty", () => {
    const parsed = modelOutputSchema.parse({
      overallStatus: "insufficient_evidence",
      insufficientReason: "Every photo is out of focus.",
      observations: [],
      hypotheses: [],
      followUpQuestions: [],
      limitations: ["No photo shows the inside of the panel"],
    });
    expect(parsed.limitations).toEqual(["No photo shows the inside of the panel"]);
  });

  it("rejects more than 10 entries", () => {
    const limitations = Array.from({ length: 11 }, (_, i) => `limitation ${i}`);
    expect(() => modelOutputSchema.parse({ ...base, limitations })).toThrow();
  });

  it("rejects an entry over 500 characters", () => {
    expect(() => modelOutputSchema.parse({ ...base, limitations: ["x".repeat(501)] })).toThrow();
  });

  it("rejects an empty or whitespace-only entry", () => {
    expect(() => modelOutputSchema.parse({ ...base, limitations: [""] })).toThrow();
    expect(() => modelOutputSchema.parse({ ...base, limitations: ["   "] })).toThrow();
  });

  it("rejects a non-string entry", () => {
    expect(() => modelOutputSchema.parse({ ...base, limitations: [42] })).toThrow();
  });
});
