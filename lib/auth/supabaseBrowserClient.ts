import { createBrowserClient } from "@supabase/ssr";

/** Client-component-only Supabase client, for sign-in/sign-up/sign-out forms. */
export function createSupabaseBrowserClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set",
    );
  }
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
