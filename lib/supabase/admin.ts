// Server-only module — never import from client components.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "@/lib/supabase/config";

let cached: SupabaseClient | null = null;

/**
 * Service-role Supabase client (server only). Bypasses RLS — used for all
 * trusted writes: profiles, game history, achievements. Returns null when
 * Supabase isn't configured.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!cached) {
    cached = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return cached;
}
