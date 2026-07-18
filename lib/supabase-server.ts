import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

// Next.js patches global fetch and caches GET requests in its Data Cache —
// including the requests supabase-js makes to PostgREST. That would freeze every
// read at the value first seen (e.g. an order stuck on 'received' while its real
// status advances), which `dynamic = 'force-dynamic'` on a route does NOT fully
// prevent because the cache key is the PostgREST URL, not the route URL. Forcing
// `cache: 'no-store'` on the Supabase client's fetch makes all reads live.
const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: 'no-store' });

/**
 * Cookie-based server Supabase client for use in Server Components and
 * Route Handlers. Respects the signed-in staff user's session (if any) via
 * cookies, so RLS policies scoped to the `authenticated` role apply
 * correctly. Uses only the public anon key.
 */
export function createServerSupabaseClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: noStoreFetch },
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // `set` can be called from a Server Component during render,
            // where mutating cookies is not allowed — safe to ignore as
            // long as middleware is also refreshing the session.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options });
          } catch {
            // See note in `set` above.
          }
        },
      },
    },
  );
}

/**
 * Service-role Supabase client for privileged server-side writes (e.g.
 * creating an order, which the anon/staff RLS policies deliberately block).
 * Bypasses Row Level Security entirely — server-only.
 *
 * NEVER import this into a 'use client' file, and never import it into any
 * page.tsx file under app/. Only import it from Route Handlers
 * (app/api/.../route.ts) that need privileged access.
 */
export function createAdminSupabaseClient() {
  return createSupabaseJsClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: { fetch: noStoreFetch },
    },
  );
}
