/**
 * Client-side image preparation for evidence upload.
 *
 * Downscaling happens before upload rather than on read: an electrician
 * on site is often on mobile data, and a modern phone camera produces
 * 4-12MB frames where a 2048px long edge is more than enough to see a
 * scorched terminal or a panel label. This also keeps uploads inside the
 * bucket's 10 MiB limit without the user ever hitting it.
 *
 * Nothing here is a security control -- the bucket's own MIME and size
 * limits are what actually constrain the upload. This is purely about not
 * wasting the user's bandwidth.
 */

export const MAX_UPLOAD_EDGE = 2048;

/** Bucket-allowed types. HEIC is absent deliberately: browsers can't
 * render it in an <img>, and iOS converts to JPEG on file-input upload. */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export type PreparedImage = {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  capturedAt?: Date;
};

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be read as an image."));
    };
    img.src = url;
  });
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function prepareImageUpload(file: File): Promise<PreparedImage> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error("Only JPEG, PNG, and WebP images can be uploaded.");
  }

  const img = await loadImage(file);
  const longestEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longestEdge > MAX_UPLOAD_EDGE ? MAX_UPLOAD_EDGE / longestEdge : 1;

  // Already small enough: upload the original bytes untouched rather than
  // re-encoding, which would only lose quality for no benefit.
  if (scale === 1) {
    return {
      blob: file,
      mimeType: file.type,
      width: img.naturalWidth,
      height: img.naturalHeight,
      byteSize: file.size,
      sha256: await sha256Hex(file),
      capturedAt: file.lastModified ? new Date(file.lastModified) : undefined,
    };
  }

  const width = Math.round(img.naturalWidth * scale);
  const height = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare the image for upload.");
  ctx.drawImage(img, 0, 0, width, height);

  // Re-encode as JPEG regardless of input: PNG photos are enormous, and
  // canvas output drops the original EXIF anyway (which Phase 2 does not
  // parse -- see the deferred-EXIF decision).
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (!blob) throw new Error("Could not prepare the image for upload.");

  return {
    blob,
    mimeType: "image/jpeg",
    width,
    height,
    byteSize: blob.size,
    sha256: await sha256Hex(blob),
    capturedAt: file.lastModified ? new Date(file.lastModified) : undefined,
  };
}
