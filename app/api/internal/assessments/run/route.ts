import { NextResponse } from "next/server";
import { verifyInternalSecret } from "@/lib/http/internalAuth";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { runQueuedAssessment } from "@/lib/ai/executor";

const MAX_DRAIN_PER_CALL = 5;

/**
 * The deployment-agnostic drain endpoint: whatever cron mechanism the
 * eventual host provides (Vercel Cron, a GitHub Action, anything that can
 * make an HTTP request on a schedule) calls this. Deliberately not
 * dependent on the in-process best-effort kick from the create route --
 * this is the guaranteed path if that kick never ran or the process was
 * killed before it finished. Safe to call concurrently with itself or
 * with an in-process kick: the executor's atomic claim (see
 * assessmentRepository.claimForRun) means only one caller ever processes
 * a given assessment.
 */
export async function POST(request: Request) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const queued = await assessmentRepository.drainQueue(MAX_DRAIN_PER_CALL);
  const results = await Promise.allSettled(
    queued.map((q) =>
      runQueuedAssessment({
        organizationId: q.organizationId,
        assessmentId: q.id,
        requestedByUserId: q.requestedByUserId,
      }),
    ),
  );

  return NextResponse.json({
    attempted: queued.length,
    succeeded: results.filter((r) => r.status === "fulfilled").length,
  });
}
