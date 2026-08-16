import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  assignOrdinalRefs,
  resolveCitedEvidence,
  CitationResolutionError,
} from "@/lib/ai/citations";

describe("assignOrdinalRefs", () => {
  it("assigns E1..En in the given order", () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const assignment = assignOrdinalRefs(ids);
    expect(assignment.map((a) => a.ordinalRef)).toEqual(["E1", "E2", "E3"]);
    expect(assignment.map((a) => a.evidenceId)).toEqual(ids);
  });

  it("handles a single evidence id", () => {
    const id = randomUUID();
    expect(assignOrdinalRefs([id])).toEqual([{ ordinalRef: "E1", evidenceId: id }]);
  });

  it("handles an empty list", () => {
    expect(assignOrdinalRefs([])).toEqual([]);
  });
});

describe("resolveCitedEvidence", () => {
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const assignment = assignOrdinalRefs(ids);

  it("resolves a valid ref to its real evidence id", () => {
    expect(resolveCitedEvidence(assignment, ["E1"])).toEqual([ids[0]]);
  });

  it("resolves multiple valid refs in order", () => {
    expect(resolveCitedEvidence(assignment, ["E3", "E1"])).toEqual([ids[2], ids[0]]);
  });

  it("throws CitationResolutionError for a ref never sent (adversarial: fabricated citation)", () => {
    // Only E1..E5 exist in this run's snapshot.
    expect(() => resolveCitedEvidence(assignment, ["E6"])).toThrow(
      CitationResolutionError,
    );
  });

  it("throws naming every unknown ref, not just the first", () => {
    try {
      resolveCitedEvidence(assignment, ["E1", "E7", "E8"]);
      expect.fail("expected CitationResolutionError");
    } catch (err) {
      expect(err).toBeInstanceOf(CitationResolutionError);
      expect((err as CitationResolutionError).unknownRefs).toEqual(["E7", "E8"]);
    }
  });

  it("throws for a ref from a completely different (empty) snapshot", () => {
    expect(() => resolveCitedEvidence([], ["E1"])).toThrow(CitationResolutionError);
  });

  it("throws for a malformed ref string that slipped past the format-only Zod check", () => {
    // Defense in depth: even if a caller skipped the Zod regex somehow,
    // this function still refuses anything not literally in the snapshot.
    expect(() => resolveCitedEvidence(assignment, ["not-a-ref"])).toThrow(
      CitationResolutionError,
    );
  });

  it("resolves an empty citation list to an empty result without throwing", () => {
    expect(resolveCitedEvidence(assignment, [])).toEqual([]);
  });

  it("does not accidentally resolve refs across two different snapshots", () => {
    const otherIds = Array.from({ length: 3 }, () => randomUUID());
    const otherAssignment = assignOrdinalRefs(otherIds);
    // E1 exists in both snapshots but must resolve to THIS snapshot's id.
    expect(resolveCitedEvidence(assignment, ["E1"])).toEqual([ids[0]]);
    expect(resolveCitedEvidence(otherAssignment, ["E1"])).toEqual([otherIds[0]]);
  });
});
