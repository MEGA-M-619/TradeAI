import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  UnauthenticatedError,
  ForbiddenOrgAccessError,
} from "@/lib/auth/session";

/**
 * Shared error -> HTTP response mapping for API route handlers. Deliberately
 * does not leak internal error details for anything unexpected (logged
 * server-side, generic 500 to the client).
 */
export function handleApiError(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (error instanceof ForbiddenOrgAccessError) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "invalid_input", issues: error.issues },
      { status: 400 },
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2025"
  ) {
    // Prisma "record not found" (e.g. update/delete on a row RLS hides
    // because it belongs to a different org, or that never existed).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  console.error(error);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
