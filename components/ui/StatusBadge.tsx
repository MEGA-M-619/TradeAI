import type { JobStatus } from "@/lib/generated/prisma/client";
import { Badge, type BadgeVariant } from "./Badge";

const STATUS_CONFIG: Record<JobStatus, { label: string; variant: BadgeVariant }> = {
  open: { label: "Open", variant: "neutral" },
  in_progress: { label: "In progress", variant: "warning" },
  completed: { label: "Completed", variant: "success" },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const config = STATUS_CONFIG[status];
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
