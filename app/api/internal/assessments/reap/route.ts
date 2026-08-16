import { NextResponse } from "next/server";
import { verifyInternalSecret } from "@/lib/http/internalAuth";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";

/**
 * External-cron-friendly complement to the opportunistic inline reap in
 * the assessment detail GET route. That inline reap only fires when
 * someone happens to be polling a stuck assessment; this endpoint gives a
 * scheduler a way to sweep stuck runs even when nobody is looking.
 */
export async function POST(request: Request) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reaped = await assessmentRepository.reapStuck();
  return NextResponse.json({ reaped: reaped.length, ids: reaped.map((r) => r.id) });
}
