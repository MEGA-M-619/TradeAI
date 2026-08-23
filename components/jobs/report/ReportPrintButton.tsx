"use client";

import { Button } from "@/components/ui";
import styles from "./ReportPrintButton.module.css";

/** The only interactive element on the report page. window.print() opens
 * the browser's native print dialog, where "Save as PDF" is a standard
 * destination -- no PDF library or server-side rendering involved. */
export function ReportPrintButton() {
  return (
    <Button
      type="button"
      variant="primary"
      onClick={() => window.print()}
      className={styles.noPrint}
    >
      Print / Save as PDF
    </Button>
  );
}
