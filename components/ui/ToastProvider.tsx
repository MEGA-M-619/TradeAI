"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useHydrated } from "@/lib/ui/useHydrated";
import styles from "./Toast.module.css";

type ToastVariant = "success" | "error";
type ToastItem = { id: number; message: string; variant: ToastVariant };

const ToastContext = createContext<{
  showToast: (message: string, variant?: ToastVariant) => void;
} | null>(null);

const AUTO_DISMISS_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const mounted = useHydrated();

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, variant: ToastVariant = "success") => {
      const id = ++nextId.current;
      setToasts((current) => [...current, { id, message, variant }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {mounted &&
        createPortal(
          <div className={styles.container} aria-live="polite">
            {toasts.map((toast) => (
              <div key={toast.id} className={`${styles.toast} ${styles[toast.variant]}`}>
                <span>{toast.message}</span>
                <button
                  type="button"
                  className={styles.dismiss}
                  onClick={() => dismiss(toast.id)}
                  aria-label="Dismiss notification"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
