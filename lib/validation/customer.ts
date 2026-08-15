import { z } from "zod";

// Preprocessing (not `.or(z.literal("")...)`) is required here: a plain
// union tries the first branch first, and an optional string schema
// happily accepts "" as a valid string without ever reaching a
// transform in a second branch. Converting "" to undefined *before*
// validation, uniformly, is what actually makes an empty form field
// behave the same as an omitted one.
const emptyToUndefined = (val: unknown) =>
  typeof val === "string" && val.trim() === "" ? undefined : val;

const optionalTrimmed = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const optionalEmail = () =>
  z.preprocess(emptyToUndefined, z.string().trim().email().max(200).optional());

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1, "Customer name is required").max(200),
  phone: optionalTrimmed(50),
  email: optionalEmail(),
  address: optionalTrimmed(500),
  notes: optionalTrimmed(2000),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
