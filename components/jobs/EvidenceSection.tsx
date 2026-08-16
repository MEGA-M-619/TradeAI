"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, ErrorState, EmptyState, ConfirmDialog, useToast } from "@/components/ui";
import {
  prepareImageUpload,
  ACCEPTED_IMAGE_TYPES,
} from "@/lib/ui/prepareImageUpload";
import styles from "./EvidenceSection.module.css";

export type EvidenceItem = {
  id: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  /** Short-lived signed URL, minted server-side per render. Absent if the
   * URL could not be produced for this object. */
  url: string | null;
};

export function EvidenceSection({
  orgId,
  jobId,
  evidence,
  limit,
}: {
  orgId: string;
  jobId: string;
  evidence: EvidenceItem[];
  limit: number;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EvidenceItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const atLimit = evidence.length >= limit;

  async function uploadOne(file: File) {
    const prepared = await prepareImageUpload(file);

    // 1. Reserve the row and get a one-shot upload URL. The server owns
    //    the bucket and path -- we never send either.
    const createRes = await fetch(`/api/orgs/${orgId}/jobs/${jobId}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mimeType: prepared.mimeType }),
    });
    if (!createRes.ok) {
      const body = await createRes.json().catch(() => null);
      if (body?.error === "too_many_evidence") {
        throw new Error(`This job already has the maximum of ${body.limit} photos.`);
      }
      throw new Error(body?.error ?? "Could not start the upload.");
    }
    const { evidence: row, upload } = await createRes.json();

    // 2. Send the bytes straight to Storage with the signed token.
    const putRes = await fetch(upload.signedUrl, {
      method: "PUT",
      headers: { "Content-Type": prepared.mimeType },
      body: prepared.blob,
    });
    if (!putRes.ok) {
      throw new Error("The image could not be uploaded.");
    }

    // 3. Only now is the row promoted to `ready` and made visible.
    const confirmRes = await fetch(
      `/api/orgs/${orgId}/jobs/${jobId}/evidence/${row.id}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          byteSize: prepared.byteSize,
          width: prepared.width,
          height: prepared.height,
          clientSha256: prepared.sha256,
          capturedAt: prepared.capturedAt?.toISOString(),
        }),
      },
    );
    if (!confirmRes.ok) {
      throw new Error("The upload finished but could not be saved.");
    }
  }

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    // Let the same file be picked again after an error or a delete.
    event.target.value = "";
    if (files.length === 0) return;

    const allowed = files.slice(0, Math.max(0, limit - evidence.length));
    if (allowed.length === 0) {
      setError(`This job already has the maximum of ${limit} photos.`);
      return;
    }

    setError(null);
    setUploading(true);
    setProgress({ done: 0, total: allowed.length });
    let succeeded = 0;
    try {
      for (const [index, file] of allowed.entries()) {
        setProgress({ done: index, total: allowed.length });
        await uploadOne(file);
        succeeded += 1;
      }
      showToast(succeeded === 1 ? "Photo added" : `${succeeded} photos added`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload the photo.");
      if (succeeded > 0) router.refresh();
    } finally {
      setUploading(false);
      setProgress(null);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/evidence/${pendingDelete.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Could not delete the photo.");
      setPendingDelete(null);
      showToast("Photo deleted");
      router.refresh();
    } catch (err) {
      setPendingDelete(null);
      setError(err instanceof Error ? err.message : "Could not delete the photo.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>Photos</h2>
        <span className={styles.count}>
          {evidence.length} of {limit}
        </span>
      </div>

      {error && (
        <div className={styles.errorRow}>
          <ErrorState title="Photo problem" description={error} />
        </div>
      )}

      <Card>
        <input
          ref={fileInputRef}
          type="file"
          className={styles.fileInput}
          accept={ACCEPTED_IMAGE_TYPES.join(",")}
          capture="environment"
          multiple
          onChange={handleFiles}
          disabled={uploading || atLimit}
        />

        {evidence.length === 0 ? (
          <EmptyState
            title="No photos yet"
            description="Photograph the panel, the fault, and anything you'll need to justify the work later."
          />
        ) : (
          <ul className={styles.grid}>
            {evidence.map((item) => (
              <li key={item.id} className={styles.tile}>
                {item.url ? (
                  // Signed Storage URLs are short-lived and their host is
                  // environment-dependent, so they can't go through the
                  // next/image optimizer.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.url}
                    alt={item.caption ?? "Job photo"}
                    className={styles.thumb}
                    loading="lazy"
                  />
                ) : (
                  <div className={styles.thumbMissing}>Unavailable</div>
                )}
                <button
                  type="button"
                  className={styles.removeButton}
                  onClick={() => setPendingDelete(item)}
                  aria-label="Delete photo"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            loading={uploading}
            loadingText={
              progress ? `Uploading ${progress.done + 1} of ${progress.total}...` : "Uploading..."
            }
            disabled={atLimit}
          >
            Add photos
          </Button>
          {atLimit && !uploading && (
            <p className={styles.limitNote}>
              Photo limit reached for this job. Delete one to add another.
            </p>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this photo?"
        description="The image file is permanently deleted. This cannot be undone."
        confirmLabel="Delete photo"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
