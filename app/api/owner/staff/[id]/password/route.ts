import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { isUuid } from '@/lib/api/constants';
import { passwordProblem } from '@/lib/staff/accounts';
import { sendPasswordLink, sendPasswordChangedNotice } from '@/lib/staff/emails';
import { buildMember, isMissingTable } from '../../_lib';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/owner/staff/[id]/password — PasswordBody. 'link' emails a
// recovery link to the personal email (400 if there isn't one); 'set'
// updates the password directly and emails a "password changed" notice. The
// password itself is never logged, echoed, or included in any response.
export async function POST(request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const allowed = await rateLimitOk(`owner-pw:${id}`, 5, 600);
  if (!allowed) return errorResponse(429, 'Too many password actions on this account — try again later');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const mode = body.mode === 'set' ? 'set' : body.mode === 'link' ? 'link' : null;
  if (!mode) return errorResponse(400, "mode must be 'link' or 'set'");

  const admin = createAdminSupabaseClient();

  const { data: profile } = await admin.from('profiles').select('name').eq('id', id).maybeSingle();
  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(id);
  if (authError || !authUser?.user) return notFound();
  const loginEmail = authUser.user.email ?? '';
  const name = (profile as { name?: string | null } | null)?.name?.trim() || '';

  const { data: accountRow, error: accountError } = await admin
    .from('staff_accounts')
    .select('login_id, personal_email, status')
    .eq('user_id', id)
    .maybeSingle();
  if (accountError && !isMissingTable(accountError)) return errorResponse(500, accountError.message);
  const account = accountRow as { login_id: string | null; personal_email: string | null; status: string } | null;

  if (account?.status === 'deactivated') return errorResponse(409, 'This account is deactivated');

  if (mode === 'link') {
    if (!account?.personal_email) return errorResponse(400, 'Add a personal email first');
    const email = await sendPasswordLink(admin, {
      userId: id,
      loginEmail,
      loginId: account.login_id ?? '',
      personalEmail: account.personal_email,
      name,
      kind: 'password_reset',
    });
    const member = await buildMember(admin, id);
    return NextResponse.json({ ok: true, member, email });
  }

  const problem = passwordProblem(body.password);
  if (problem) return errorResponse(400, problem);
  const password = body.password as string;

  const { error: updateErr } = await admin.auth.admin.updateUserById(id, { password });
  if (updateErr) return errorResponse(500, updateErr.message);

  const email = await sendPasswordChangedNotice(admin, {
    userId: id,
    loginEmail,
    personalEmail: account?.personal_email,
    name,
  });
  const member = await buildMember(admin, id);
  return NextResponse.json({ ok: true, member, email });
}
