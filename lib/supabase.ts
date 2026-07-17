import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client — safe to import into any 'use client' component.
 * Reads only the public env vars (never the service-role key).
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
