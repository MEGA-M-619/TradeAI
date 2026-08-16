"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/auth/supabaseBrowserClient";
import { FormField, Input, Button, ErrorState } from "@/components/ui";
import { AuthShell } from "@/components/auth/AuthShell";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      router.push("/orgs");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Log in"
      subtitle="Manage your electrical jobs from the field."
      footer={
        <>
          No account? <Link href="/signup">Sign up</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <FormField label="Email" htmlFor="login-email" required>
          <Input
            id="login-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </FormField>
        <FormField label="Password" htmlFor="login-password" required>
          <Input
            id="login-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </FormField>
        {error && <ErrorState title="Could not log in" description={error} />}
        <div style={{ marginTop: "var(--space-5)" }}>
          <Button
            type="submit"
            variant="primary"
            fullWidth
            loading={submitting}
            loadingText="Logging in..."
          >
            Log in
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
