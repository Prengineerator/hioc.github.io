import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { rateLimitOk, clientIp } from '@/lib/api/rateLimit';
import { getUserRole } from '@/lib/api/auth';
import {
  audienceForRole,
  isValidAudience,
  mayUseDoor,
  wrongDoorMessage,
} from '@/lib/auth/audience';

export const dynamic = 'force-dynamic';

// POST /api/auth/login — public (this IS the login action).
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { email, password } = body;
  if (typeof email !== 'string' || email.trim().length === 0) {
    return errorResponse(400, 'email is required and must be a non-empty string');
  }
  if (typeof password !== 'string' || password.length === 0) {
    return errorResponse(400, 'password is required and must be a non-empty string');
  }

  // S1: throttle password login per email + IP to block credential-stuffing / brute force.
  if (!(await rateLimitOk(`login:${email.trim().toLowerCase()}:${clientIp(request)}`, 10, 600))) {
    return errorResponse(429, 'Too many attempts. Please wait a few minutes and try again.');
  }

  // Cookie-bound server client — signInWithPassword writes the resulting
  // session tokens back out as Set-Cookie headers via the cookies() adapter
  // in lib/supabase-server.ts (the @supabase/ssr cookie-writing pattern).
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return errorResponse(401, 'Invalid email or password');
  }

  // Each surface has its own login page and admits only its own role. The
  // credentials were correct — this is about WHICH DOOR they were presented at.
  //
  // The check runs AFTER sign-in because the role lives in `profiles`, which is
  // not readable until there is a session. So a wrong-door attempt briefly
  // holds a valid session and we must SIGN IT OUT again; returning an error
  // while leaving the cookies in place would be worse than not checking at all,
  // since the caller could simply navigate on.
  const audience = body.audience;
  if (isValidAudience(audience) && data.user) {
    const role = await getUserRole(data.user);
    if (!mayUseDoor(role, audience)) {
      await supabase.auth.signOut();
      return errorResponse(403, wrongDoorMessage(audienceForRole(role), audience));
    }
  }

  return NextResponse.json({ success: true });
}
