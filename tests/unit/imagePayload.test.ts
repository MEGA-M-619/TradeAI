import { describe, expect, it } from "vitest";
import {
  assertImageCountWithinLimit,
  assertImageWithinLimits,
  assertTotalWithinLimit,
  base64ByteLength,
  ImagePayloadError,
  MAX_ASSESSMENT_IMAGE_BYTES,
  MAX_ASSESSMENT_TOTAL_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  PROVIDER_MAX_IMAGE_BASE64_BYTES,
  PROVIDER_MAX_REQUEST_BYTES,
  sniffMediaType,
} from "@/lib/ai/imagePayload";
import { MAX_ASSESSMENT_IMAGES } from "@/lib/validation/assessment";

/**
 * The whole point of this module is that it judges the ACTUAL bytes, so
 * these helpers build byte arrays with real format signatures rather than
 * mocking the check out.
 */
function jpegBytes(byteLength = 64): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
}

function pngBytes(byteLength = 64): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function webpBytes(byteLength = 64): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return bytes;
}

/** Asserts the thrown error is an ImagePayloadError of the given category
 * -- category is what becomes the persisted AssessmentFailureCategory, so
 * "it threw" is not a strong enough assertion anywhere in this file. */
function expectPayloadError(fn: () => unknown, category: ImagePayloadError["category"]) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ImagePayloadError);
    expect((err as ImagePayloadError).category).toBe(category);
    return;
  }
  throw new Error(`expected an ImagePayloadError with category ${category}, but nothing was thrown`);
}

describe("base64ByteLength", () => {
  it("matches what Buffer actually produces, including every padding case", () => {
    for (const rawLength of [0, 1, 2, 3, 4, 5, 6, 7, 100, 1023, 4096]) {
      const encoded = Buffer.from(new Uint8Array(rawLength)).toString("base64");
      expect(base64ByteLength(rawLength)).toBe(encoded.length);
    }
  });
});

describe("provider ceilings", () => {
  // These mirror the module-load assertions in lib/ai/imagePayload.ts.
  // Duplicated here so raising a limit past its documented ceiling fails a
  // normal test run, not only a cold start of the server.
  it("the per-image limit base64-encodes to less than the provider's per-image ceiling", () => {
    expect(base64ByteLength(MAX_ASSESSMENT_IMAGE_BYTES)).toBeLessThan(
      PROVIDER_MAX_IMAGE_BASE64_BYTES,
    );
  });

  it("the total limit base64-encodes to less than the provider's request ceiling", () => {
    expect(base64ByteLength(MAX_ASSESSMENT_TOTAL_IMAGE_BYTES)).toBeLessThan(
      PROVIDER_MAX_REQUEST_BYTES,
    );
  });

  it("leaves headroom under the request ceiling for the prompt, tool schema, and JSON envelope", () => {
    const headroom = PROVIDER_MAX_REQUEST_BYTES - base64ByteLength(MAX_ASSESSMENT_TOTAL_IMAGE_BYTES);
    expect(headroom).toBeGreaterThan(1_000_000);
  });

  it("re-exports the request schema's image cap rather than defining a second one", () => {
    expect(MAX_IMAGE_COUNT).toBe(MAX_ASSESSMENT_IMAGES);
  });
});

describe("sniffMediaType", () => {
  it("identifies each supported format from its signature", () => {
    expect(sniffMediaType(jpegBytes())).toBe("image/jpeg");
    expect(sniffMediaType(pngBytes())).toBe("image/png");
    expect(sniffMediaType(webpBytes())).toBe("image/webp");
  });

  it("returns null for empty bytes", () => {
    expect(sniffMediaType(new Uint8Array(0))).toBeNull();
  });

  it("returns null for a non-image payload", () => {
    expect(sniffMediaType(new TextEncoder().encode("<html>not an image</html>"))).toBeNull();
  });

  it("returns null for a RIFF container that is not WebP (e.g. a WAV)", () => {
    const wav = new Uint8Array(64);
    wav.set([0x52, 0x49, 0x46, 0x46]); // "RIFF"
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(sniffMediaType(wav)).toBeNull();
  });

  it("returns null for a truncated signature rather than reading past the end", () => {
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
    expect(sniffMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
  });
});

describe("assertImageCountWithinLimit", () => {
  it("accepts a count at exactly the limit (boundary)", () => {
    expect(() => assertImageCountWithinLimit(MAX_IMAGE_COUNT)).not.toThrow();
  });

  it("accepts counts below the limit", () => {
    expect(() => assertImageCountWithinLimit(0)).not.toThrow();
    expect(() => assertImageCountWithinLimit(1)).not.toThrow();
  });

  it("rejects one over the limit as payload_too_large (boundary)", () => {
    expectPayloadError(() => assertImageCountWithinLimit(MAX_IMAGE_COUNT + 1), "payload_too_large");
  });

  it("rejects a wildly oversized selection", () => {
    expectPayloadError(() => assertImageCountWithinLimit(500), "payload_too_large");
  });
});

describe("assertImageWithinLimits", () => {
  it("accepts a valid image and returns the media type derived from the bytes", () => {
    expect(assertImageWithinLimits("ev-1", "image/jpeg", jpegBytes())).toBe("image/jpeg");
    expect(assertImageWithinLimits("ev-2", "image/png", pngBytes())).toBe("image/png");
    expect(assertImageWithinLimits("ev-3", "image/webp", webpBytes())).toBe("image/webp");
  });

  it("accepts an image at exactly the per-image limit (boundary)", () => {
    const bytes = jpegBytes(MAX_ASSESSMENT_IMAGE_BYTES);
    expect(() => assertImageWithinLimits("ev-1", "image/jpeg", bytes)).not.toThrow();
  });

  it("rejects an image one byte over the per-image limit (boundary)", () => {
    const bytes = jpegBytes(MAX_ASSESSMENT_IMAGE_BYTES + 1);
    expectPayloadError(
      () => assertImageWithinLimits("ev-1", "image/jpeg", bytes),
      "payload_too_large",
    );
  });

  it("rejects an image that is oversized even though its signature is valid", () => {
    // Size is checked before format on purpose: an object at the storage
    // bucket's own 10 MiB ceiling is a perfectly valid JPEG and still must
    // not be forwarded.
    const bytes = jpegBytes(10 * 1024 * 1024);
    expectPayloadError(
      () => assertImageWithinLimits("ev-1", "image/jpeg", bytes),
      "payload_too_large",
    );
  });

  it("rejects bytes that are not a supported image at all", () => {
    const notAnImage = new TextEncoder().encode("PK this is a zip file");
    expectPayloadError(
      () => assertImageWithinLimits("ev-1", "image/jpeg", notAnImage),
      "unsupported_media_type",
    );
  });

  it("rejects an empty object (a truncated or failed upload)", () => {
    expectPayloadError(
      () => assertImageWithinLimits("ev-1", "image/png", new Uint8Array(0)),
      "unsupported_media_type",
    );
  });

  it("rejects bytes whose real format contradicts the recorded mime type", () => {
    // The evidence row's mime_type is a client assertion made at confirm
    // time. This is the check that stops it being taken on trust.
    expectPayloadError(
      () => assertImageWithinLimits("ev-1", "image/jpeg", pngBytes()),
      "unsupported_media_type",
    );
    expectPayloadError(
      () => assertImageWithinLimits("ev-1", "image/webp", jpegBytes()),
      "unsupported_media_type",
    );
  });

  it("rejects a declared mime type outside the supported set, even with valid bytes", () => {
    // GIF is a format the provider accepts but this application does not
    // (see ALLOWED_EVIDENCE_MIME_TYPES) -- the narrower set wins.
    expectPayloadError(
      () => assertImageWithinLimits("ev-1", "image/gif", jpegBytes()),
      "unsupported_media_type",
    );
    expectPayloadError(
      () => assertImageWithinLimits("ev-1", "application/pdf", jpegBytes()),
      "unsupported_media_type",
    );
  });
});

describe("assertTotalWithinLimit", () => {
  it("accepts a running total below the limit", () => {
    expect(() => assertTotalWithinLimit(0)).not.toThrow();
    expect(() => assertTotalWithinLimit(1024)).not.toThrow();
  });

  it("accepts a total at exactly the limit (boundary)", () => {
    expect(() => assertTotalWithinLimit(MAX_ASSESSMENT_TOTAL_IMAGE_BYTES)).not.toThrow();
  });

  it("rejects one byte over the limit as payload_too_large (boundary)", () => {
    expectPayloadError(
      () => assertTotalWithinLimit(MAX_ASSESSMENT_TOTAL_IMAGE_BYTES + 1),
      "payload_too_large",
    );
  });

  it("rejects a set of individually-legal images that exceed the budget together", () => {
    // The realistic failure: every image passes the per-image check, and
    // the combined request is still too big. Simulates the executor's
    // accumulate-then-check loop without allocating the bytes.
    let total = 0;
    let rejectedAt: number | null = null;
    for (let i = 1; i <= MAX_IMAGE_COUNT; i += 1) {
      total += MAX_ASSESSMENT_IMAGE_BYTES;
      try {
        assertTotalWithinLimit(total);
      } catch (err) {
        expect(err).toBeInstanceOf(ImagePayloadError);
        expect((err as ImagePayloadError).category).toBe("payload_too_large");
        rejectedAt = i;
        break;
      }
    }
    // 5 MiB each against a 20 MiB budget: the fifth image is the one that
    // crosses it, and the loop stops there rather than downloading 8.
    expect(rejectedAt).toBe(5);
  });

  it("permits the full image count when the images are ordinary field photos", () => {
    // A 2048px JPEG at quality 0.85 is comfortably under 2 MB; eight of
    // them must not trip the budget, or the limit would be unusable.
    const perImage = 2 * 1024 * 1024;
    expect(() => assertTotalWithinLimit(perImage * MAX_IMAGE_COUNT)).not.toThrow();
  });
});
