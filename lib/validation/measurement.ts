import { z } from "zod";

// See lib/validation/customer.ts for why this is a preprocess step and
// not a `.or(z.literal("")...)` union.
const emptyToUndefined = (val: unknown) =>
  typeof val === "string" && val.trim() === "" ? undefined : val;

const optionalTrimmed = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

export const MEASUREMENT_TEST_TYPES = [
  "voltage_ac",
  "voltage_dc",
  "continuity",
  "resistance",
  "current_ac",
  "current_dc",
  "insulation_resistance",
  "ground_impedance",
] as const;

export type MeasurementTestTypeInput = (typeof MEASUREMENT_TEST_TYPES)[number];

/**
 * A closed allow-list per test type, not a free-text unit field: the same
 * discipline as lib/validation/assessment.ts's safetyCategorySchema --
 * pick from a fixed vocabulary rather than write arbitrary text, so a
 * later reader (the deterministic rule engine, a chart, an export) can
 * trust the unit matches the test type without re-parsing it.
 */
export const ALLOWED_UNITS_BY_TEST_TYPE: Record<
  MeasurementTestTypeInput,
  readonly string[]
> = {
  voltage_ac: ["V"],
  voltage_dc: ["V"],
  continuity: ["Ω"],
  resistance: ["Ω"],
  current_ac: ["A", "mA"],
  current_dc: ["A", "mA"],
  insulation_resistance: ["MΩ"],
  ground_impedance: ["Ω"],
};

export const createMeasurementSchema = z
  .object({
    circuitId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
    evidenceId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
    testType: z.enum(MEASUREMENT_TEST_TYPES),
    value: z.number().finite(),
    unit: z.string().trim().min(1).max(20),
    expectedMin: z.number().finite().optional(),
    expectedMax: z.number().finite().optional(),
    note: optionalTrimmed(2000),
    recordedAt: z.coerce.date().optional(),
  })
  .superRefine((data, ctx) => {
    const allowedUnits = ALLOWED_UNITS_BY_TEST_TYPE[data.testType];
    if (!allowedUnits.includes(data.unit)) {
      ctx.addIssue({
        code: "custom",
        path: ["unit"],
        message: `unit must be one of: ${allowedUnits.join(", ")} for test type "${data.testType}"`,
      });
    }
    if (
      data.expectedMin !== undefined &&
      data.expectedMax !== undefined &&
      data.expectedMin > data.expectedMax
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedMin"],
        message: "expectedMin must not exceed expectedMax",
      });
    }
  });

export type CreateMeasurementInput = z.infer<typeof createMeasurementSchema>;
