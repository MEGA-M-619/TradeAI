"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/auth/supabaseBrowserClient";
import { Button, type ButtonVariant } from "@/components/ui/Button";

export function SignOutButton({
  variant = "secondary",
  fullWidth,
}: {
  variant?: ButtonVariant;
  fullWidth?: boolean;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleSignOut() {
    setSubmitting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      await supabase.auth.signOut();
      router.push("/login");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      fullWidth={fullWidth}
      onClick={handleSignOut}
      loading={submitting}
      loadingText="Signing out..."
    >
      Sign out
    </Button>
  );
}
