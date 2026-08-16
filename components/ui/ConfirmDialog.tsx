"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import styles from "./ConfirmDialog.module.css";
import { Button, type ButtonVariant } from "./Button";

/**
 * Centered modal on desktop, bottom sheet on mobile (see
 * ConfirmDialog.module.css) -- replaces native window.confirm() for
 * destructive actions so they get a real, on-brand confirmation step
 * instead of a browser-chrome dialog.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "dangerSolid",
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={styles.backdrop}
      onClick={onCancel}
      role="presentation"
    >
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.grabber} aria-hidden="true" />
        <p className={styles.title} id="confirm-dialog-title">
          {title}
        </p>
        {description && <p className={styles.description}>{description}</p>}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={confirmVariant}
            onClick={onConfirm}
            loading={loading}
            loadingText="Working..."
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
