"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/auth/supabaseBrowserClient";
import { FormField, Input, Button, ErrorState } from "@/components/ui";
import { AuthShell } from "@/components/auth/AuthShell";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });
      if (signUpError) {
        setError(signUpError.message);
        return;
      }
      if (data.session) {
        // Email confirmation is disabled on this project -- already logged in.
        router.push("/orgs");
        router.refresh();
        return;
      }
      // Email confirmation required before a session exists.
      setCheckEmail(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (checkEmail) {
    return (
      <AuthShell title="Check your email">
        <p>
          We sent a confirmation link to <strong>{email}</strong>. Follow it to
          finish setting up your account.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Sign up"
      subtitle="Manage your electrical jobs from the field."
      footer={
        <>
          Already have an account? <Link href="/login">Log in</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <FormField label="Email" htmlFor="signup-email" required>
          <Input
            id="signup-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </FormField>
        <FormField
          label="Password"
          htmlFor="signup-password"
          required
          hint="At least 8 characters."
        >
          <Input
            id="signup-password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </FormField>
        {error && <ErrorState title="Could not sign up" description={error} />}
        <div style={{ marginTop: "var(--space-5)" }}>
          <Button
            type="submit"
            variant="primary"
            fullWidth
            loading={submitting}
            loadingText="Signing up..."
          >
            Sign up
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
