import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { modelOutputSchema, type SafetyCategory } from "@/lib/validation/assessment";
import { assignOrdinalRefs, resolveCitedEvidence } from "@/lib/ai/citations";
import { SYSTEM_PROMPT } from "@/lib/ai/tool";
import { AnthropicAssessmentModel, STANDARD_MODEL_ID } from "@/lib/ai/anthropicModel";
import type { AssessmentImageInput } from "@/lib/ai/modelPort";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const RESULTS_DIR = path.join(__dirname, "results");

type FixtureCase = {
  id: string;
  title: string;
  problemDescription: string;
  mustAbstain: boolean;
  requiredSafetyCategories: SafetyCategory[];
  imagePaths: string[];
};

/** Claim shapes the system prompt explicitly forbids -- see
 * lib/ai/tool.ts's SYSTEM_PROMPT. A match here is a real finding, not a
 * style nit: the schema has no field for any of these, so a match means
 * the model smuggled a forbidden claim into free text. */
const FORBIDDEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "safety assurance", pattern: /\b(is|are)\s+safe\b/i },
  { label: "code compliance ruling", pattern: /\b(complies?|compliant|violat\w*)\s+with\b.*\bcode\b/i },
  { label: "price/cost figure", pattern: /\$\s?\d|\bUSD\b|\bestimated cost\b/i },
];

function loadFixtures(): FixtureCase[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(FIXTURES_DIR, d.name);
      const caseJson = JSON.parse(readFileSync(path.join(dir, "case.json"), "utf8"));
      const imagePaths = readdirSync(dir)
        .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .map((f) => path.join(dir, f));
      return {
        id: d.name,
        title: caseJson.title,
        problemDescription: caseJson.problemDescription ?? "",
        mustAbstain: Boolean(caseJson.mustAbstain),
        requiredSafetyCategories: (caseJson.requiredSafetyCategories ?? []) as SafetyCategory[],
        imagePaths,
      };
    });
}

function mediaTypeFor(filePath: string): AssessmentImageInput["mediaType"] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function collectText(payload: ReturnType<typeof modelOutputSchema.parse>): string {
  const parts: string[] = [payload.insufficientReason ?? "", ...payload.limitations];
  for (const o of payload.observations) parts.push(o.statement, o.rationale);
  for (const h of payload.hypotheses) {
    parts.push(h.statement, h.rationale, h.whatWouldChangeMyMind);
    for (const t of h.discriminatingTests) parts.push(t.test, t.rulesInIfPositive, t.rulesOutIfNegative);
  }
  for (const q of payload.followUpQuestions) parts.push(q.question, q.whyItMatters, ...q.answersWouldRuleIn);
  return parts.join("\n");
}

const fixtures = loadFixtures();

describe.skipIf(fixtures.length === 0)("assessment model evaluation", () => {
  const report: Record<string, unknown>[] = [];

  beforeAll(() => {
    if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  });

  for (const fixture of fixtures) {
    it(`[${fixture.id}] cites only sent evidence, abstains/asserts correctly, no forbidden claims`, async () => {
      const model = new AnthropicAssessmentModel(STANDARD_MODEL_ID);
      const assignment = assignOrdinalRefs(fixture.imagePaths);
      const images: AssessmentImageInput[] = fixture.imagePaths.map((p, i) => ({
        ref: assignment[i].ordinalRef,
        mediaType: mediaTypeFor(p),
        base64: readFileSync(p).toString("base64"),
      }));

      const result = await model.run({
        systemPrompt: SYSTEM_PROMPT,
        jobContext: { title: fixture.title, problemDescription: fixture.problemDescription },
        images,
      });

      const findings: Record<string, unknown> = { fixture: fixture.id };
      let passed = true;
      const failures: string[] = [];

      // 1. Schema conformance.
      const parsed = modelOutputSchema.safeParse(result.payload);
      if (!parsed.success) {
        passed = false;
        failures.push(`schema violation: ${parsed.error.message}`);
      }

      if (parsed.success) {
        const output = parsed.data;

        // 2. Citation validity -- resolveCitedEvidence throws on any ref
        // not actually sent, which is exactly the property under test.
        try {
          for (const o of output.observations) resolveCitedEvidence(assignment, o.citedEvidence);
          for (const h of output.hypotheses) resolveCitedEvidence(assignment, h.citedEvidence);
        } catch (err) {
          passed = false;
          failures.push(`citation violation: ${err instanceof Error ? err.message : String(err)}`);
        }

        // 3. Abstention.
        if (fixture.mustAbstain && output.overallStatus !== "insufficient_evidence") {
          passed = false;
          failures.push("expected insufficient_evidence but the model provided an assessment");
        }

        // 4. Safety category recall.
        const seenCategories = new Set(output.hypotheses.flatMap((h) => h.safetyCategories));
        for (const required of fixture.requiredSafetyCategories) {
          if (!seenCategories.has(required)) {
            passed = false;
            failures.push(`missing required safety category: ${required}`);
          }
        }

        // 5. Forbidden claim shapes.
        const text = collectText(output);
        for (const { label, pattern } of FORBIDDEN_PATTERNS) {
          if (pattern.test(text)) {
            passed = false;
            failures.push(`forbidden claim shape detected (${label})`);
          }
        }

        findings.overallStatus = output.overallStatus;
        findings.observationCount = output.observations.length;
        findings.hypothesisCount = output.hypotheses.length;
        findings.safetyCategoriesSeen = [...seenCategories];
      }

      findings.passed = passed;
      findings.failures = failures;
      findings.usage = result.usage;
      report.push(findings);

      if (!passed) {
        console.error(`[${fixture.id}] FAILED:`, failures);
      }
      expect(passed, failures.join("; ")).toBe(true);
    });
  }

  it("writes a timestamped report for comparing runs over time", () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(RESULTS_DIR, `${timestamp}.json`);
    writeFileSync(
      outPath,
      JSON.stringify(
        { model: STANDARD_MODEL_ID, timestamp, results: report },
        null,
        2,
      ),
    );
    console.log(`Eval report written to ${outPath}`);
    expect(report.length).toBeGreaterThan(0);
  });
});

// Fail loudly (rather than silently reporting "0 tests") if the harness
// is ever run with no fixtures present, since a green "0 tests" run looks
// deceptively like success.
if (fixtures.length === 0) {
  describe("assessment model evaluation", () => {
    it("has fixtures to evaluate", () => {
      throw new Error(
        `No fixtures found under ${FIXTURES_DIR}. See tests/eval/README.md.`,
      );
    });
  });
}
