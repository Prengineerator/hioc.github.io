// Shared bits for the owner Team screen (components/owner/TeamManager.tsx and
// this directory): role display, the "how long ago did they sign in" string,
// and the single place that turns an EmailOutcome into a toast — so the Add
// staff form and the row Password action can't say something different for
// the same server answer. See docs/PHASE-5-STAFF-ACCOUNTS.md "Owner portal".

import type { BadgeVariant } from '@/components/ui/Badge';
import type { EmailOutcome } from '@/lib/staff/accounts';

// TeamMember.role is `TeamRole | 'customer'` — deactivation flips
// profiles.role to 'customer' server-side (SA-D2), so a deactivated row can
// legitimately arrive with role 'customer'. Label it plainly rather than
// crash or show a raw enum value.
export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'Staff',
  customer: 'Deactivated',
};

export const ROLE_BADGE_VARIANT: Record<string, BadgeVariant> = {
  owner: 'tan',
  manager: 'outline',
  staff: 'neutral',
  customer: 'neutral',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

export function roleBadgeVariant(role: string): BadgeVariant {
  return ROLE_BADGE_VARIANT[role] ?? 'neutral';
}

/** "n min/hr/days ago" for a week, then a plain IST calendar date. */
export function formatLastSignIn(iso: string | null): string {
  if (!iso) return 'Never signed in';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Never signed in';

  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return diffDay === 1 ? '1 day ago' : `${diffDay} days ago`;

  return d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export interface ToastState {
  tone: 'success' | 'warning';
  text: string;
}

/**
 * The one place that turns a password-link/notice EmailOutcome into what the
 * owner sees, for both the Add staff form and the row Password action:
 *  - mode 'link': sent → confirms the address; failed/skipped → amber + detail.
 *  - mode 'set': the owner already knows the password (they typed it) — never
 *    shown again after the modal closes — so the toast reminds them to hand
 *    it over in person, and only flags the "password changed" notice email
 *    if that failed to send.
 */
export function passwordToast(to: string, mode: 'link' | 'set', email?: EmailOutcome): ToastState {
  if (mode === 'link') {
    if (email?.status === 'sent') return { tone: 'success', text: `Set-password link sent to ${to}.` };
    return {
      tone: 'warning',
      text: `Set-password link not sent${email?.detail ? ` — ${email.detail}` : ''}.`,
    };
  }
  const reminder = "Password set. Share it with them in person — it won't be shown again.";
  if (email && email.status !== 'sent') {
    return { tone: 'warning', text: `${reminder} (Notice email not sent — ${email.detail || email.status}.)` };
  }
  return { tone: 'success', text: reminder };
}
