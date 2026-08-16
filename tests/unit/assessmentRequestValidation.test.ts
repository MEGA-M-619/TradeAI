import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createAssessmentSchema,
  verdictSchema,
  MAX_ASSESSMENT_IMAGES,
} from "@/lib/validation/assessment";

describe("createAssessmentSchema", () => {
  it("accepts 1 to 8 evidence ids and defaults escalate to false", () => {
    const result = createAssessmentSchema.parse({ evidenceIds: [randomUUID()] });
    expect(result.escalate).toBe(false);
  });

  it("accepts exactly the maximum of 8 images", () => {
    const ids = Array.from({ length: MAX_ASSESSMENT_IMAGES }, () => randomUUID());
    expect(() => createAssessmentSchema.parse({ evidenceIds: ids })).not.toThrow();
  });

  it("rejects more than 8 images (D9 cap)", () => {
    const ids = Array.from({ length: MAX_ASSESSMENT_IMAGES + 1 }, () => randomUUID());
    expect(() => createAssessmentSchema.parse({ evidenceIds: ids })).toThrow();
  });

  it("rejects zero evidence ids", () => {
    expect(() => createAssessmentSchema.parse({ evidenceIds: [] })).toThrow();
  });

  it("rejects duplicate evidence ids", () => {
    const id = randomUUID();
    expect(() => createAssessmentSchema.parse({ evidenceIds: [id, id] })).toThrow();
  });

  it("rejects a non-uuid evidence id", () => {
    expect(() => createAssessmentSchema.parse({ evidenceIds: ["not-a-uuid"] })).toThrow();
  });

  it("accepts an explicit escalate: true", () => {
    const result = createAssessmentSchema.parse({
      evidenceIds: [randomUUID()],
      escalate: true,
    });
    expect(result.escalate).toBe(true);
  });
});

describe("verdictSchema", () => {
  it("accepts each verdict kind with no note", () => {
    for (const verdict of ["confirmed", "rejected", "amended", "unresolved"] as const) {
      expect(() => verdictSchema.parse({ verdict })).not.toThrow();
    }
  });

  it("rejects an unknown verdict kind", () => {
    expect(() => verdictSchema.parse({ verdict: "maybe" })).toThrow();
  });

  it("treats an empty-string note as absent", () => {
    const result = verdictSchema.parse({ verdict: "confirmed", note: "   " });
    expect(result.note).toBeUndefined();
  });

  it("trims and keeps a real note", () => {
    const result = verdictSchema.parse({ verdict: "amended", note: "  Actually a loose lug.  " });
    expect(result.note).toBe("Actually a loose lug.");
  });
});
