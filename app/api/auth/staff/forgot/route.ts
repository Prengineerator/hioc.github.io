import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { rateLimitOk, clientIp } from '@/lib/api/rateLimit';
import { normalizeLoginId, loginEmailFor, TEAM_ROLES, type TeamRole } from '@/lib/staff/accounts';
import { sendPasswordLink } from '@/lib/staff/emails';
import { staffDisplayName } from '@/lib/staff/displayName';

export const dynamic = 'force-dynamic';

// POST /api/auth/staff/forgot — public (this IS the "forgot password" action).
//
// docs/PHASE-5-STAFF-ACCOUNTS.md, "Password emails": always the same generic
// 200 response, whether the login ID exists, is inactive, has no personal
// email, or is a typo — anything else would let someone probe which login IDs
// are real staff accounts. The only different status is 429, since a rate
// limit itself reveals nothing about a particular account.
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  const rawLoginId = typeof body?.loginId === 'string' ? body.loginId.trim().toLowerCase() : '';

  const ip = clientIp(request);
  if (!(await rateLimitOk(`staff-forgot-ip:${ip}`, 10, 3600))) {
    return errorResponse(429, 'Too many attempts. Please wait a while and try again.');
  }
  // Keyed on the raw text the caller typed (not the normalized login ID) so a
  // string that fails to normalize still gets throttled per distinct guess.
  if (rawLoginId && !(await rateLimitOk(`staff-forgot:${rawLoginId}`, 3, 3600))) {
    return errorResponse(429, 'Too many attempts. Please wait a while and try again.');
  }

  const loginId = normalizeLoginId(rawLoginId);
  if (loginId) {
    try {
      await maybeSendResetLink(loginId);
    } catch (err) {
      // Never let a send failure change the response — that itself would be
      // an account-enumeration signal (errors only for real accounts).
      console.error('staff forgot-password: unexpected failure', err);
    }
  }

  return NextResponse.json({ ok: true });
}

async function maybeSendResetLink(loginId: string): Promise<void> {
  const admin = createAdminSupabaseClient();

  const { data: account, error: accountError } = await admin
    .from('staff_accounts')
    .select('user_id, personal_email, status')
    .eq('login_id', loginId)
    .maybeSingle();
  // Covers both "no such login ID" and "staff_accounts isn't migrated yet" —
  // either way, nothing to send.
  if (accountError || !account) return;

  const row = account as { user_id: string; personal_email: string | null; status: string };
  if (row.status !== 'active' || !row.personal_email) return;

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('role, name')
    .eq('id', row.user_id)
    .maybeSingle();
  if (profileError || !profile) return;

  const role = (profile as { role: string | null }).role;
  if (!TEAM_ROLES.includes(role as TeamRole)) return;

  const loginEmail = loginEmailFor(loginId);
  const name = staffDisplayName((profile as { name: string | null }).name, loginEmail);

  await sendPasswordLink(admin, {
    userId: row.user_id,
    loginEmail,
    loginId,
    personalEmail: row.personal_email,
    name,
    kind: 'password_reset',
  });
}
