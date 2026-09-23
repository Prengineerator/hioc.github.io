import 'server-only';

// Every email to a staffer (docs/PHASE-5-STAFF-ACCOUNTS.md). Always addressed
// to staff_accounts.personal_email — never the <id>@hioc.in login ID, which is
// not a mailbox. Every attempt is logged in staff_emails, and nothing here
// throws: an account change or a payroll finalize must never fail because an
// email did.
//
// Password links carry Supabase's hashed_token to OUR page
// (/staff/reset-password?token_hash=…) instead of Supabase's action_link: no
// Auth redirect-URL setup, and an email scanner that pre-fetches the link
// can't burn the one-time token — it is only verified when the staffer
// submits a new password (POST /api/auth/staff/reset).

import type { SupabaseClient } from '@supabase/supabase-js';
import { emailAdapter } from '@/lib/notifications/adapters';
import { absoluteUrl } from '@/lib/url';
import { CAFE_NAME } from '@/lib/constants';
import type { EmailOutcome, StaffEmailKind } from '@/lib/staff/accounts';

export const RESET_PATH = '/staff/reset-password';

function staffFrom(): string | undefined {
  return process.env.RESEND_FROM_STAFF || undefined; // adapter falls back to RESEND_FROM
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Shared email chrome so every staff email looks like the bill email. */
export function staffEmailShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#faf7f4;font-family:Arial,Helvetica,sans-serif;color:#232325;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#fffdfa;border:1px solid #e5e5e5;border-radius:8px;">
      <tr><td style="padding:28px 28px 8px;text-align:center;">
        <img src="${absoluteUrl('/images/logo-black.png')}" alt="${CAFE_NAME}" width="140" style="display:inline-block;width:140px;max-width:60%;height:auto;border:0;" />
      </td></tr>
      <tr><td style="padding:8px 28px 28px;">
        <h1 style="font-size:18px;margin:8px 0 12px;">${escapeHtml(title)}</h1>
        ${bodyHtml}
      </td></tr>
    </table>
  </body>
</html>`;
}

function button(href: string, label: string): string {
  return `<p style="text-align:center;margin:24px 0;"><a href="${href}" style="display:inline-block;background:#b08968;color:#fffdfa;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:6px;font-size:14px;">${escapeHtml(label)}</a></p>`;
}

/**
 * Send one email to a staffer and log it. `to` null/empty → logged 'skipped'.
 */
export async function sendStaffEmail(
  admin: SupabaseClient,
  args: {
    userId: string;
    kind: StaffEmailKind;
    ref?: string;
    to: string | null | undefined;
    subject: string;
    html: string;
    text: string;
  },
): Promise<EmailOutcome> {
  const to = (args.to ?? '').trim();
  let outcome: EmailOutcome;
  let providerRef = '';
  if (!to) {
    outcome = { kind: args.kind, status: 'skipped', detail: 'no personal email' };
  } else {
    const res = await emailAdapter.send({
      to,
      channel: 'email',
      body: args.text,
      subject: args.subject,
      html: args.html,
      from: staffFrom(),
    });
    providerRef = res.providerRef;
    outcome = res.ok
      ? { kind: args.kind, status: 'sent', detail: '' }
      : { kind: args.kind, status: 'failed', detail: res.error || 'send failed' };
  }

  const { error } = await admin.from('staff_emails').insert({
    user_id: args.userId,
    kind: args.kind,
    ref: args.ref ?? '',
    to_email: to,
    status: outcome.status,
    provider_ref: providerRef,
    error: outcome.detail,
  });
  if (error) console.error('staff_emails log insert failed', args.kind, error);
  return outcome;
}

/**
 * Email a set-password (invite) or reset-password link to the personal email.
 * The link is valid for Supabase's recovery-OTP lifetime (Auth settings).
 */
export async function sendPasswordLink(
  admin: SupabaseClient,
  args: {
    userId: string;
    loginEmail: string;
    loginId: string;
    personalEmail: string | null | undefined;
    name: string;
    kind: 'invite' | 'password_reset';
  },
): Promise<EmailOutcome> {
  if (!args.personalEmail) {
    return sendStaffEmail(admin, { ...args, to: null, subject: '', html: '', text: '' });
  }
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: args.loginEmail,
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) {
    console.error('generateLink failed', args.userId, error);
    const outcome: EmailOutcome = { kind: args.kind, status: 'failed', detail: 'could not create link' };
    await admin.from('staff_emails').insert({
      user_id: args.userId,
      kind: args.kind,
      to_email: args.personalEmail,
      status: 'failed',
      error: outcome.detail,
    });
    return outcome;
  }

  const link = absoluteUrl(`${RESET_PATH}?token_hash=${encodeURIComponent(tokenHash)}`);
  const first = escapeHtml(args.name.split(' ')[0] || 'there');
  const invite = args.kind === 'invite';
  const subject = invite ? `Welcome to ${CAFE_NAME} — set your password` : `Reset your ${CAFE_NAME} staff password`;
  const intro = invite
    ? `Hi ${first}, an account has been created for you on the ${CAFE_NAME} staff app.`
    : `Hi ${first}, we received a request to reset your ${CAFE_NAME} staff password.`;
  const html = staffEmailShell(
    invite ? 'Set your password' : 'Reset your password',
    `<p style="font-size:14px;line-height:1.5;">${intro}</p>
     <p style="font-size:14px;line-height:1.5;">Your login ID is <strong>${escapeHtml(args.loginEmail)}</strong>.</p>
     ${button(link, invite ? 'Set password' : 'Reset password')}
     <p style="font-size:12px;color:#8a8a8a;line-height:1.5;">This link works once and expires soon. If you didn't expect this email, you can ignore it — your password stays unchanged.</p>`,
  );
  const text = `${intro}\nLogin ID: ${args.loginEmail}\n${invite ? 'Set' : 'Reset'} your password: ${link}\nThis link works once and expires soon.`;
  return sendStaffEmail(admin, {
    userId: args.userId,
    kind: args.kind,
    to: args.personalEmail,
    subject,
    html,
    text,
  });
}

/** Notice after the owner sets a password. Never includes the password. */
export async function sendPasswordChangedNotice(
  admin: SupabaseClient,
  args: { userId: string; loginEmail: string; personalEmail: string | null | undefined; name: string },
): Promise<EmailOutcome> {
  const first = escapeHtml(args.name.split(' ')[0] || 'there');
  const html = staffEmailShell(
    'Your password was changed',
    `<p style="font-size:14px;line-height:1.5;">Hi ${first}, the password for your ${CAFE_NAME} staff login <strong>${escapeHtml(args.loginEmail)}</strong> was just changed by the owner.</p>
     <p style="font-size:14px;line-height:1.5;">Ask the owner for your new password. If you weren't expecting this, tell them straight away.</p>`,
  );
  return sendStaffEmail(admin, {
    userId: args.userId,
    kind: 'password_changed',
    to: args.personalEmail,
    subject: `Your ${CAFE_NAME} staff password was changed`,
    html,
    text: `The password for your ${CAFE_NAME} staff login ${args.loginEmail} was changed by the owner. Ask them for the new one.`,
  });
}
