// One rule for "what do we call this staffer", shared by every owner surface
// (attendance sheet, payroll, dashboard leaderboard, order attribution) so they
// can't drift. Staff accounts are created as <name>@hioc.in and most never get
// a profiles.name, which is why screens showed "(no name)" / "Unknown staff".
// Precedence: profiles.name → the email's local part, title-cased → fallback.

import type { SupabaseClient } from '@supabase/supabase-js';

/** "ayush.garg@hioc.in" → "Ayush Garg". Pure; '' when nothing usable. */
export function nameFromEmail(email: string | null | undefined): string {
  if (!email) return '';
  const local = email.split('@')[0]?.trim() ?? '';
  if (!local) return '';
  return local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function staffDisplayName(
  profileName: string | null | undefined,
  email: string | null | undefined,
  fallback = 'Unknown staff',
): string {
  const n = profileName?.trim();
  if (n) return n;
  return nameFromEmail(email) || fallback;
}

/**
 * Resolve display names for a set of user ids. Reads profiles.name first and
 * only asks auth.users (service role) for the ids still unnamed. A lookup
 * failure degrades to whatever was resolved — it never throws.
 */
export async function getStaffDisplayNames(
  admin: SupabaseClient,
  ids: string[],
  fallback = 'Unknown staff',
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;

  const { data: profs, error } = await admin.from('profiles').select('id, name').in('id', unique);
  if (error) console.error('getStaffDisplayNames profiles lookup failed', error);
  for (const p of (profs ?? []) as { id: string; name: string | null }[]) {
    if (p.name?.trim()) out.set(p.id, p.name.trim());
  }

  const unnamed = unique.filter((id) => !out.has(id));
  if (unnamed.length > 0) {
    // One paged scan of auth.users beats one getUserById round-trip per
    // unnamed id — the same page-through-1000 pattern
    // app/api/owner/staff/route.ts uses to build its id→email map.
    const emailById = await loadEmailMap(admin);
    for (const id of unnamed) {
      out.set(id, staffDisplayName(null, emailById.get(id), fallback));
    }
  }
  return out;
}

async function loadEmailMap(admin: SupabaseClient): Promise<Map<string, string>> {
  const emailById = new Map<string, string>();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      console.error('getStaffDisplayNames auth lookup failed', error);
      break;
    }
    if (!data) break;
    for (const u of data.users) emailById.set(u.id, u.email ?? '');
    if (data.users.length < 1000) break;
  }
  return emailById;
}
