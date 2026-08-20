import { describe, expect, it } from "vitest";
import {
  createDiagnosticSessionSchema,
  createCandidateCauseSchema,
  updateCandidateCauseSchema,
  DIAGNOSTIC_CAUSE_STATUSES,
  DIAGNOSTIC_SESSION_STATUSES,
} from "@/lib/validation/diagnostics";

describe("createDiagnosticSessionSchema", () => {
  it("accepts a valid symptom", () => {
    const result = createDiagnosticSessionSchema.parse({
      symptom: "Breaker trips within 5 seconds of reset",
    });
    expect(result.symptom).toBe("Breaker trips within 5 seconds of reset");
  });

  it("trims surrounding whitespace", () => {
    const result = createDiagnosticSessionSchema.parse({
      symptom: "  Kitchen outlets dead  ",
    });
    expect(result.symptom).toBe("Kitchen outlets dead");
  });

  it("rejects an empty symptom", () => {
    expect(() => createDiagnosticSessionSchema.parse({ symptom: "" })).toThrow();
  });

  it("rejects a whitespace-only symptom", () => {
    expect(() =>
      createDiagnosticSessionSchema.parse({ symptom: "   " }),
    ).toThrow();
  });

  it("rejects a missing symptom", () => {
    expect(() => createDiagnosticSessionSchema.parse({})).toThrow();
  });

  it("rejects a symptom over 2000 characters", () => {
    expect(() =>
      createDiagnosticSessionSchema.parse({ symptom: "x".repeat(2001) }),
    ).toThrow();
  });

  it("accepts a symptom at exactly the 2000 character boundary", () => {
    const result = createDiagnosticSessionSchema.parse({
      symptom: "x".repeat(2000),
    });
    expect(result.symptom).toHaveLength(2000);
  });
});

describe("createCandidateCauseSchema", () => {
  it("accepts a statement with no recommendedNextTest", () => {
    const result = createCandidateCauseSchema.parse({
      statement: "Loose neutral connection at the panel",
    });
    expect(result.statement).toBe("Loose neutral connection at the panel");
    expect(result.recommendedNextTest).toBeUndefined();
  });

  it("accepts a statement with a recommendedNextTest", () => {
    const result = createCandidateCauseSchema.parse({
      statement: "Loose neutral connection at the panel",
      recommendedNextTest: "Check torque on neutral bus bar lugs",
    });
    expect(result.recommendedNextTest).toBe(
      "Check torque on neutral bus bar lugs",
    );
  });

  it("treats an empty-string recommendedNextTest as absent", () => {
    const result = createCandidateCauseSchema.parse({
      statement: "Loose neutral connection at the panel",
      recommendedNextTest: "   ",
    });
    expect(result.recommendedNextTest).toBeUndefined();
  });

  it("rejects an empty statement", () => {
    expect(() =>
      createCandidateCauseSchema.parse({ statement: "" }),
    ).toThrow();
  });

  it("rejects a missing statement", () => {
    expect(() => createCandidateCauseSchema.parse({})).toThrow();
  });

  it("rejects a statement over 2000 characters", () => {
    expect(() =>
      createCandidateCauseSchema.parse({ statement: "x".repeat(2001) }),
    ).toThrow();
  });

  it("rejects a recommendedNextTest over 2000 characters", () => {
    expect(() =>
      createCandidateCauseSchema.parse({
        statement: "A cause",
        recommendedNextTest: "x".repeat(2001),
      }),
    ).toThrow();
  });
});

describe("updateCandidateCauseSchema", () => {
  it("accepts an empty object (no fields changed)", () => {
    const result = updateCandidateCauseSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts a status-only update", () => {
    const result = updateCandidateCauseSchema.parse({ status: "confirmed" });
    expect(result.status).toBe("confirmed");
  });

  it("rejects a status outside the closed vocabulary", () => {
    expect(() =>
      updateCandidateCauseSchema.parse({ status: "diagnosed" }),
    ).toThrow();
  });

  it("distinguishes an absent recommendedNextTest from an explicit null (clear)", () => {
    const absent = updateCandidateCauseSchema.parse({ status: "candidate" });
    expect("recommendedNextTest" in absent).toBe(false);

    const cleared = updateCandidateCauseSchema.parse({
      recommendedNextTest: null,
    });
    expect(cleared.recommendedNextTest).toBeNull();
  });

  it("accepts a recommendedNextTest string update", () => {
    const result = updateCandidateCauseSchema.parse({
      recommendedNextTest: "Megger the branch circuit",
    });
    expect(result.recommendedNextTest).toBe("Megger the branch circuit");
  });

  it("distinguishes an absent resolvingMeasurementId from an explicit null (unlink)", () => {
    const absent = updateCandidateCauseSchema.parse({ status: "candidate" });
    expect("resolvingMeasurementId" in absent).toBe(false);

    const cleared = updateCandidateCauseSchema.parse({
      resolvingMeasurementId: null,
    });
    expect(cleared.resolvingMeasurementId).toBeNull();
  });

  it("accepts a valid resolvingMeasurementId uuid", () => {
    const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const result = updateCandidateCauseSchema.parse({
      resolvingMeasurementId: uuid,
    });
    expect(result.resolvingMeasurementId).toBe(uuid);
  });

  it("rejects a non-uuid resolvingMeasurementId", () => {
    expect(() =>
      updateCandidateCauseSchema.parse({ resolvingMeasurementId: "not-a-uuid" }),
    ).toThrow();
  });
});

describe("closed vocabularies", () => {
  it("DIAGNOSTIC_SESSION_STATUSES matches the schema.prisma enum", () => {
    expect(DIAGNOSTIC_SESSION_STATUSES).toEqual([
      "open",
      "investigating",
      "diagnosed",
      "abandoned",
    ]);
  });

  it("DIAGNOSTIC_CAUSE_STATUSES matches the schema.prisma enum", () => {
    expect(DIAGNOSTIC_CAUSE_STATUSES).toEqual([
      "candidate",
      "confirmed",
      "ruled_out",
    ]);
  });
});
