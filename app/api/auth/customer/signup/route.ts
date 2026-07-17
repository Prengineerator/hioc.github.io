import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

const MIN_PASSWORD_LENGTH = 8;

// POST /api/auth/customer/signup — public. Creates a new email+password
// account (role defaults to 'customer' via the profiles trigger). Password
// hashing is handled entirely by Supabase Auth (bcrypt) — no custom crypto
// here.
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { email, password } = body;
  if (typeof email !== 'string' || email.trim().length === 0) {
    return errorResponse(400, 'email is required and must be a non-empty string');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return errorResponse(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
  });

  if (error) {
    return errorResponse(400, error.message);
  }

  // Supabase's anti-enumeration behavior: signing up with an email that
  // already has an account returns success (no `error`) with an empty
  // `identities` array rather than an error, so a re-entered existing
  // email doesn't otherwise reveal whether it's registered. Without this
  // check, that case fell through to the "check your email" success
  // message below, which is misleading — nothing was actually created.
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    return errorResponse(400, 'An account with this email already exists. Try logging in instead.');
  }

  // With "Confirm email" on (Supabase's default), signUp() returns no
  // session until the user clicks the confirmation email link — the caller
  // needs to know which happened so it doesn't imply instant login.
  return NextResponse.json({ success: true, needsEmailConfirmation: data.session === null });
}
