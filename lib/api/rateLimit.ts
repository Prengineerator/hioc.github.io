import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';

// Best-effort rate limit (M10), backed by the rate_limits table +
// check_rate_limit RPC (supabase/phase2-hardening.sql). Returns true when the
// request is ALLOWED. Fails OPEN (allows) if the RPC isn't deployed yet, so auth
// keeps working until the hardening SQL is applied.
export async function rateLimitOk(key: string, max: number, windowSecs: number): Promise<boolean> {
  try {
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin.rpc('check_rate_limit', {
      p_key: key,
      p_max: max,
      p_window_secs: windowSecs,
    });
    if (error) {
      console.error('check_rate_limit unavailable; allowing request', error);
      return true;
    }
    return data === true;
  } catch {
    return true;
  }
}

// Best-effort client IP from proxy headers (Vercel sets x-forwarded-for).
export function clientIp(request: Request): string {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
}
