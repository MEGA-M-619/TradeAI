import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createCustomerSchema,
  updateCustomerSchema,
} from "@/lib/validation/customer";
import { createJobSchema, updateJobSchema } from "@/lib/validation/job";
import { createOrganizationSchema } from "@/lib/validation/organization";

describe("createOrganizationSchema", () => {
  it("accepts a trimmed, non-empty name", () => {
    const result = createOrganizationSchema.parse({
      name: "  Acme Electric  ",
    });
    expect(result.name).toBe("Acme Electric");
  });

  it("rejects an empty name", () => {
    expect(() => createOrganizationSchema.parse({ name: "" })).toThrow();
    expect(() => createOrganizationSchema.parse({ name: "   " })).toThrow();
  });
});

describe("createCustomerSchema", () => {
  it("requires a name but allows everything else to be omitted", () => {
    const result = createCustomerSchema.parse({ name: "Jane Doe" });
    expect(result.name).toBe("Jane Doe");
    expect(result.phone).toBeUndefined();
  });

  it("rejects a missing name", () => {
    expect(() => createCustomerSchema.parse({})).toThrow();
  });

  it("treats empty-string optional fields as absent, not as validation errors", () => {
    const result = createCustomerSchema.parse({
      name: "Jane Doe",
      phone: "",
      email: "",
      address: "",
      notes: "",
    });
    expect(result.phone).toBeUndefined();
    expect(result.email).toBeUndefined();
  });

  it("rejects a malformed email", () => {
    expect(() =>
      createCustomerSchema.parse({ name: "Jane Doe", email: "not-an-email" }),
    ).toThrow();
  });
});

describe("updateCustomerSchema", () => {
  it("allows a partial update with no fields at all", () => {
    expect(updateCustomerSchema.parse({})).toEqual({});
  });
});

describe("createJobSchema", () => {
  it("requires a valid customerId and a title", () => {
    expect(() =>
      createJobSchema.parse({ customerId: "not-a-uuid", title: "No power" }),
    ).toThrow();

    const result = createJobSchema.parse({
      customerId: randomUUID(),
      title: "No power to kitchen outlets",
    });
    expect(result.title).toBe("No power to kitchen outlets");
  });

  it("rejects a missing title", () => {
    expect(() =>
      createJobSchema.parse({
        customerId: randomUUID(),
      }),
    ).toThrow();
  });
});

describe("updateJobSchema", () => {
  it("only accepts the three known fields, including a valid status enum", () => {
    const result = updateJobSchema.parse({ status: "in_progress" });
    expect(result.status).toBe("in_progress");
  });

  it("rejects an invalid status value", () => {
    expect(() => updateJobSchema.parse({ status: "cancelled" })).toThrow();
  });
});
