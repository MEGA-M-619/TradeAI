import { z } from "zod";

/**
 * Note what is deliberately absent from every schema here: organization
 * id, job id, bucket name, and storage path. Those are all derived
 * server-side from the verified session and the route params -- accepting
 * any of them from the client would hand the caller the authorization
 * decision. See lib/storage/evidenceStorage.ts.
 */

/** Mirrors the bucket's allowed_mime_types, which Storage enforces on the
 * actual upload. Duplicated here so a bad request fails fast with a clear
 * 400 rather than only failing later at the Storage boundary. */
export const ALLOWED_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** Mirrors the bucket's file_size_limit (10 MiB). */
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

/** Longest edge the client downscales to; the limit here is generous
 * enough to allow for an imperfect client-side resize without accepting
 * an obviously bogus dimension. */
export const MAX_EVIDENCE_DIMENSION = 4096;

/** Per-job cap, checked server-side against the live count. */
export const MAX_EVIDENCE_PER_JOB = 24;

export const createEvidenceSchema = z.object({
  mimeType: z.enum(ALLOWED_EVIDENCE_MIME_TYPES),
  caption: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(500).optional(),
  ),
});

export const confirmEvidenceSchema = z.object({
  byteSize: z.number().int().positive().max(MAX_EVIDENCE_BYTES),
  width: z.number().int().positive().max(MAX_EVIDENCE_DIMENSION).optional(),
  height: z.number().int().positive().max(MAX_EVIDENCE_DIMENSION).optional(),
  // Client-asserted; the server never sees the bytes with direct upload,
  // so this is recorded as a claim and never treated as verified.
  clientSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha-256")
    .optional(),
  capturedAt: z.coerce.date().optional(),
});

export type CreateEvidenceInput = z.infer<typeof createEvidenceSchema>;
export type ConfirmEvidenceInput = z.infer<typeof confirmEvidenceSchema>;
