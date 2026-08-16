/**
 * Client-safe Supabase configuration. Key-gated: when the environment
 * variables are missing, the whole identity layer degrades to guest-only
 * mode and nothing crashes.
 *
 * Required keys (paste into the project's Keys panel / Vercel env vars):
 *  - NEXT_PUBLIC_SUPABASE_URL        https://<project>.supabase.co
 *  - NEXT_PUBLIC_SUPABASE_ANON_KEY   public anon key
 *  - SUPABASE_SERVICE_ROLE_KEY       secret service-role key (server only)
 */

export const SUPABASE_URL: string | undefined =
  process.env.NEXT_PUBLIC_SUPABASE_URL || undefined;

export const SUPABASE_ANON_KEY: string | undefined =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || undefined;

export const SUPABASE_SERVICE_ROLE_KEY: string | undefined =
  process.env.SUPABASE_SERVICE_ROLE_KEY || undefined;

/** Full identity + persistence flow available (client + server keys). */
export function supabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
}

/** Only the public (client) side is configured — auth UI can render. */
export function supabaseClientConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
