import { MAX_ASSESSMENT_IMAGES } from "@/lib/validation/assessment";
import { ALLOWED_EVIDENCE_MIME_TYPES } from "@/lib/validation/evidence";
import type { AssessmentImageInput } from "@/lib/ai/modelPort";

/**
 * Server-side payload governance for the assessment model call.
 *
 * Everything upstream of this module describes what the *client* sent:
 * `prepareImageUpload.ts` downscales in the browser and says outright that
 * it is not a security control, and `evidence.byte_size` / `mime_type` are
 * values the client asserted at confirm time. The client also holds a
 * signed direct-to-storage upload URL, so it chooses the bytes that end up
 * in the bucket. None of that constrains what this application forwards to
 * a third party.
 *
 * These functions are the constraint, and they run against the ACTUAL
 * bytes fetched back from storage -- never the metadata on the row. They
 * are pure and synchronous so the executor can apply them inside its
 * existing download loop and fail before spending another network round
 * trip, and so they are testable without a database or a model.
 */

export type AssessmentMediaType = AssessmentImageInput["mediaType"];

// --- Provider ceilings (documented, not chosen by us) ------------------
//
// From Anthropic's vision documentation, recorded here so the limits below
// can be audited against their source rather than taken on faith. If these
// change, the assertions at the bottom of this file are what will tell you
// whether our own caps are still inside them.

/** Documented maximum for a single image, measured AFTER base64 encoding. */
export const PROVIDER_MAX_IMAGE_BASE64_BYTES = 10_000_000;

/** Documented maximum size of one Messages API request in total. */
export const PROVIDER_MAX_REQUEST_BYTES = 32_000_000;

/** Base64 encodes 3 bytes as 4 characters; `base64ByteLength` is exact. */
export function base64ByteLength(rawByteLength: number): number {
  return 4 * Math.ceil(rawByteLength / 3);
}

// --- Our limits (stricter than the ceilings, on purpose) ---------------
//
// Stated in RAW bytes, because raw bytes are what we can measure the
// instant the download completes -- before paying to base64-encode
// anything. The provider ceilings above are stated in encoded bytes, so
// every limit here is checked against its ceiling via base64ByteLength().

/**
 * Per-image cap. A 2048px JPEG at quality 0.85 -- what the client produces
 * for a phone photo -- is well under 2 MB, so this leaves generous room for
 * a legitimately large or poorly-compressed field photo while refusing the
 * pathological case. Deliberately below the evidence bucket's own 10 MiB
 * per-object limit: an object at the bucket maximum base64-encodes to
 * ~14 MB, which is past the provider's per-image ceiling on its own.
 */
export const MAX_ASSESSMENT_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Total across every image in one assessment. NOT derived from the
 * per-image cap: 8 images at 5 MiB each would be 40 MiB, so this is the
 * binding constraint in practice and is meant to be. Sized so the encoded
 * payload (~28 MB) leaves several MB of headroom under the provider's
 * request ceiling for the JSON envelope, the system prompt, and the tool
 * schema, none of which are counted here.
 */
export const MAX_ASSESSMENT_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Image count. Re-exported from the request schema rather than redefined,
 * so the executor and the API route can never disagree about the cap --
 * this is a second enforcement point for the same number, not a second
 * number. The provider allows far more; 8 is this product's own limit.
 */
export const MAX_IMAGE_COUNT = MAX_ASSESSMENT_IMAGES;

export class ImagePayloadError extends Error {
  constructor(
    public readonly category: "payload_too_large" | "unsupported_media_type",
    message: string,
  ) {
    super(message);
    this.name = "ImagePayloadError";
  }
}

// --- Format detection --------------------------------------------------

/** Byte-for-byte prefix comparison; `offset` supports WebP's split magic. */
function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const JPEG_SOI = [0xff, 0xd8, 0xff] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP", at offset 8

/**
 * Identifies the format from the bytes themselves. Returns null for
 * anything that is not one of the three formats this application accepts
 * -- including an empty file, a truncated upload, or a non-image that was
 * uploaded with an image mime type.
 *
 * This is the "validate the actual bytes" half of the check. The evidence
 * row's `mime_type` is a client assertion made at confirm time; a client
 * that lies about it, or an upload that was truncated after the row was
 * confirmed, produces a mismatch here rather than a confusing failure
 * inside the provider's decoder.
 */
export function sniffMediaType(bytes: Uint8Array): AssessmentMediaType | null {
  if (startsWith(bytes, JPEG_SOI)) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  return null;
}

// --- Assertions --------------------------------------------------------

/** Call once, before downloading anything -- the count is known upfront. */
export function assertImageCountWithinLimit(count: number): void {
  if (count > MAX_IMAGE_COUNT) {
    throw new ImagePayloadError(
      "payload_too_large",
      `This assessment selected ${count} photos, which is more than the limit of ${MAX_IMAGE_COUNT}.`,
    );
  }
}

/**
 * Per-image checks against the real bytes. Returns the media type derived
 * from those bytes -- the caller sends *this*, not the row's declared mime
 * type, so what is announced to the model is always what was actually
 * verified.
 */
export function assertImageWithinLimits(
  evidenceId: string,
  declaredMimeType: string,
  bytes: Uint8Array,
): AssessmentMediaType {
  if (bytes.byteLength > MAX_ASSESSMENT_IMAGE_BYTES) {
    throw new ImagePayloadError(
      "payload_too_large",
      `Evidence ${evidenceId} is ${bytes.byteLength} bytes, over the per-image limit of ${MAX_ASSESSMENT_IMAGE_BYTES}.`,
    );
  }

  const actual = sniffMediaType(bytes);
  if (actual === null) {
    throw new ImagePayloadError(
      "unsupported_media_type",
      `Evidence ${evidenceId} is not a readable JPEG, PNG, or WebP image.`,
    );
  }
  // Both directions matter. An unsupported declared type means the row
  // should never have been assessable; a mismatch means the stored bytes
  // are not what the row claims they are.
  if (!(ALLOWED_EVIDENCE_MIME_TYPES as readonly string[]).includes(declaredMimeType)) {
    throw new ImagePayloadError(
      "unsupported_media_type",
      `Evidence ${evidenceId} has an unsupported mime type for assessment: ${declaredMimeType}.`,
    );
  }
  if (actual !== declaredMimeType) {
    throw new ImagePayloadError(
      "unsupported_media_type",
      `Evidence ${evidenceId} is recorded as ${declaredMimeType} but the stored bytes are ${actual}.`,
    );
  }

  return actual;
}

/**
 * Running-total check. Called after each image is added rather than once at
 * the end, so a set that blows the budget stops downloading at the image
 * that crossed it instead of pulling every remaining object into memory
 * first.
 */
export function assertTotalWithinLimit(totalBytes: number): void {
  if (totalBytes > MAX_ASSESSMENT_TOTAL_IMAGE_BYTES) {
    throw new ImagePayloadError(
      "payload_too_large",
      `The selected photos total ${totalBytes} bytes, over the combined limit of ${MAX_ASSESSMENT_TOTAL_IMAGE_BYTES}.`,
    );
  }
}

// --- Self-check ---------------------------------------------------------
//
// Asserted at module load, in the same spirit as the MAX_ASSESSMENT_IMAGES
// check in lib/validation/assessment.ts: the limits above are meant to be
// easy to change, and the thing that makes that safe is that raising one
// past its provider ceiling fails loudly and immediately rather than
// producing rejected requests in production. There is a matching unit test
// so this also fails a normal test run, not only a cold start.

if (base64ByteLength(MAX_ASSESSMENT_IMAGE_BYTES) > PROVIDER_MAX_IMAGE_BASE64_BYTES) {
  throw new Error(
    "MAX_ASSESSMENT_IMAGE_BYTES base64-encodes to more than the provider's per-image limit",
  );
}
if (base64ByteLength(MAX_ASSESSMENT_TOTAL_IMAGE_BYTES) > PROVIDER_MAX_REQUEST_BYTES) {
  throw new Error(
    "MAX_ASSESSMENT_TOTAL_IMAGE_BYTES base64-encodes to more than the provider's request limit",
  );
}
if (MAX_ASSESSMENT_IMAGE_BYTES > MAX_ASSESSMENT_TOTAL_IMAGE_BYTES) {
  throw new Error(
    "MAX_ASSESSMENT_IMAGE_BYTES must not exceed MAX_ASSESSMENT_TOTAL_IMAGE_BYTES",
  );
}
