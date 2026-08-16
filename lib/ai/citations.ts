/**
 * Ordinal-reference resolution: the app-layer half of citation integrity.
 * The database constraint (ai_assessment_citation's composite FK into
 * ai_assessment_input) is what makes a fabricated citation impossible to
 * persist; this module is what turns the model's "E3" into a real
 * evidence id *before* that write happens, so a bad response fails with a
 * clear, categorized error instead of an opaque constraint violation.
 *
 * The model never sees a database UUID. It sees ordinal refs (E1..E8)
 * assigned once, in the order the technician selected evidence, and cites
 * those refs back. This is cheaper in tokens than repeating a UUID per
 * citation, and it makes an out-of-range reference (a model citing "E9"
 * when only 5 images were sent) a trivial equality check rather than a
 * plausible-looking-but-wrong id that would need a database round trip to
 * catch.
 */

export type OrdinalAssignment = { ordinalRef: string; evidenceId: string };

/** Deterministic E1..E8 assignment, in the order given. The order itself
 * is the technician's own selection order -- nothing here reorders it. */
export function assignOrdinalRefs(evidenceIds: string[]): OrdinalAssignment[] {
  return evidenceIds.map((evidenceId, index) => ({
    ordinalRef: `E${index + 1}`,
    evidenceId,
  }));
}

export class CitationResolutionError extends Error {
  constructor(public readonly unknownRefs: string[]) {
    super(
      `Model cited evidence reference(s) not present in the input snapshot: ${unknownRefs.join(", ")}`,
    );
    this.name = "CitationResolutionError";
  }
}

/**
 * Resolves a list of model-cited refs (e.g. ["E1", "E3"]) against the
 * assignment actually sent to the model. Throws CitationResolutionError
 * naming every unresolvable ref if any is missing -- this function never
 * silently drops a bad citation, because a silently-dropped citation would
 * make an under-cited finding look normal instead of surfacing the
 * failure.
 */
export function resolveCitedEvidence(
  assignment: OrdinalAssignment[],
  citedRefs: string[],
): string[] {
  const byRef = new Map(assignment.map((a) => [a.ordinalRef, a.evidenceId]));
  const unknown: string[] = [];
  const resolved: string[] = [];

  for (const ref of citedRefs) {
    const evidenceId = byRef.get(ref);
    if (evidenceId === undefined) {
      unknown.push(ref);
    } else {
      resolved.push(evidenceId);
    }
  }

  if (unknown.length > 0) {
    throw new CitationResolutionError(unknown);
  }
  return resolved;
}
