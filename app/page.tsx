import { redirect } from "next/navigation";
import { getAuthenticatedUserId } from "@/lib/auth/session";

export default async function Home() {
  try {
    await getAuthenticatedUserId();
  } catch {
    redirect("/login");
  }
  redirect("/orgs");
}
