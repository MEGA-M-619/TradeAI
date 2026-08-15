import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { createOrganizationSchema } from "@/lib/validation/organization";
import { handleApiError } from "@/lib/http/handleApiError";

// No [orgId] segment here -- there is no org context yet. This is the
// bootstrap surface: "which orgs am I in" and "create a new one", both of
// which organizationRepository intentionally supports without a
// pre-verified org context (see its own comments).

export async function GET() {
  try {
    const userId = await getAuthenticatedUserId();
    const organizations = await organizationRepository.listForUser(userId);
    return NextResponse.json({ organizations });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    const body = createOrganizationSchema.parse(await request.json());
    const organization = await organizationRepository.create(userId, body.name);
    return NextResponse.json({ organization }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
