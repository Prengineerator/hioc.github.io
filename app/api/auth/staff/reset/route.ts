import { NextResponse } from 'next/server';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { rateLimitOk, clientIp } from '@/lib/api/rateLimit';
import { passwordProblem, TEAM_ROLES, type TeamRole } from '@/lib/staff/accounts';

export const dynamic = 'force-dynamic';

const EXPIRED_MESSAGE = 'This link has expired or was already used — ask for a new one.';
const INVALID_ACCOUNT_MESSAGE = 'This link is no longer valid.';

/**
 * A plain, cookie-less anon client, used only to verify the recovery token.
 * Deliberately NOT the cookie-bound createServerSupabaseClient() — verifying
 * the token must not itself establish a session (via Set-Cookie) before we've
 * confirmed the account is still an active staff account below. The actual
 * login session is established afterwards, the normal way, with
 * signInWithPassword.
 */
function createPlainAnonClient() {
  return createSupabaseJsClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// POST /api/auth/staff/reset — public (the token IS the credential here).
//
// docs/PHASE-5-STAFF-ACCOUNTS.md, "Password emails". token_hash comes from the
// link lib/staff/emails.ts sent to the staffer's personal email
// (/staff/reset-password?token_hash=…); it is Supabase's recovery hashed_token
// and is only consumed here, on submit — never on page load.
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const tokenHash = typeof body.token_hash === 'string' ? body.token_hash.trim() : '';
  if (!tokenHash) {
    return errorResponse(400, 'token_hash is required');
  }

  const pwProblem = passwordProblem(body.password);
  if (pwProblem) {
    return errorResponse(400, pwProblem);
  }
  // passwordProblem() returning null only when its argument is a string —
  // safe to narrow now that the check above passed.
  const password = body.password as string;

  const ip = clientIp(request);
  if (!(await rateLimitOk(`staff-reset-ip:${ip}`, 20, 3600))) {
    return errorResponse(429, 'Too many attempts. Please wait a while and try again.');
  }

  const anon = createPlainAnonClient();
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'recovery',
  });
  const user = verified?.user;
  if (verifyError || !user) {
    return errorResponse(400, EXPIRED_MESSAGE);
  }

  const admin = createAdminSupabaseClient();

  const { data: account, error: accountError } = await admin
    .from('staff_accounts')
    .select('status')
    .eq('user_id', user.id)
    .maybeSingle();
  if (accountError || !account || (account as { status: string }).status !== 'active') {
    return errorResponse(403, INVALID_ACCOUNT_MESSAGE);
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  const role = (profile as { role: string | null } | null)?.role;
  if (profileError || !profile || !TEAM_ROLES.includes(role as TeamRole)) {
    return errorResponse(403, INVALID_ACCOUNT_MESSAGE);
  }

  // Never log `password` itself — only that an update happened.
  const { error: updateError } = await admin.auth.admin.updateUserById(user.id, { password });
  if (updateError) {
    console.error('staff reset-password: updateUserById failed', user.id, updateError.message);
    return errorResponse(500, 'Could not reset your password. Please try again.');
  }

  const loginEmail = user.email;
  if (!loginEmail) {
    return errorResponse(500, 'Could not reset your password. Please try again.');
  }

  // Sign the staffer in the normal way — same cookie-bound mechanism as
  // /api/auth/login — so they land in the staff app already logged in with
  // the password they just set, rather than the recovery-token session.
  const supabase = createServerSupabaseClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: loginEmail,
    password,
  });
  if (signInError) {
    // The password WAS changed successfully; only the auto-login failed.
    // Still a success from the caller's point of view — they can sign in by
    // hand with the new password.
    console.error('staff reset-password: post-reset sign-in failed', user.id, signInError.message);
  }

  return NextResponse.json({ ok: true });
}
