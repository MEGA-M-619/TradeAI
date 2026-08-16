"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import styles from "./OrgSwitcher.module.css";

type OrgOption = { id: string; name: string };

export function OrgSwitcher({
  organizations,
  currentOrgId,
}: {
  organizations: OrgOption[];
  currentOrgId: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const current = organizations.find((org) => org.id === currentOrgId);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className={styles.currentName}>{current?.name ?? "Select organization"}</span>
        <svg
          className={styles.chevron}
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          {organizations.map((org) => (
            <Link
              key={org.id}
              href={`/orgs/${org.id}/jobs`}
              className={styles.menuItem}
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              {org.name}
              {org.id === currentOrgId && (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 8l3 3 7-7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </Link>
          ))}
          <Link
            href="/orgs"
            className={styles.menuItemMuted}
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Manage organizations
          </Link>
        </div>
      )}
    </div>
  );
}
