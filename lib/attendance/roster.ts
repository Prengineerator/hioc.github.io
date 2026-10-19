// The team the attendance sheet counts, and the approved leave that schedules a
// day off. Shared by the owner's sheet (app/api/owner/attendance/route.ts) and
// the staff reports (lib/reports/exports/staffReportsServer.ts), so both count
// the same people and the same days off.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getStaffDisplayNames } from '@/lib/staff/displayName';

/** The roles on the team roster. Customers are not staff. */
export const TEAM_ROLES: string[] = ['staff', 'manager', 'owner'];

export interface TeamMember {
  id: string;
  name: string;
  role: string;
}

export type TeamRoster =
  | { ok: true; people: TeamMember[]; displayNames: Map<string, string> }
  | { ok: false; message: string };

/**
 * Everyone on the team, sorted by display name. A person with no punches still
 * belongs here: a whole month of nothing is a fact the owner needs to see.
 * Names are resolved through getStaffDisplayNames because profiles.name is
 * usually empty (staff sign in as <name>@hioc.in and never set it).
 */
export async function loadTeamRoster(admin: SupabaseClient): Promise<TeamRoster> {
  const { data: profileRows, error: profileErr } = await admin
    .from('profiles')
    .select('id, name, role')
    .in('role', TEAM_ROLES);
  if (profileErr) return { ok: false, message: profileErr.message };
  const people = (profileRows ?? []) as TeamMember[];

  const displayNames = await getStaffDisplayNames(
    admin,
    people.map((p) => p.id),
  );
  people.sort((a, b) =>
    (displayNames.get(a.id) ?? '').localeCompare(displayNames.get(b.id) ?? ''),
  );
  return { ok: true, people, displayNames };
}

export interface ApprovedLeaveRow {
  user_id: string;
  leave_date: string;
}

/**
 * Approved leave days in [from, to]. Each one is the week's rostered day off
 * (LEAVE): without it the sheet would mark someone ABSENT on a day their manager
 * had cleared. A failed read comes back as no rows and an `error` message, so a
 * caller can decide whether that matters.
 */
export async function loadApprovedLeave(
  admin: SupabaseClient,
  from: string,
  to: string,
): Promise<{ rows: ApprovedLeaveRow[]; error: string | null }> {
  const { data, error } = await admin
    .from('leave_requests')
    .select('user_id, leave_date')
    .eq('status', 'approved')
    .gte('leave_date', from)
    .lte('leave_date', to);
  return { rows: (data ?? []) as ApprovedLeaveRow[], error: error ? error.message : null };
}

/**
 * Whether a person's date is the approved day off, for rollUpDay's `scheduledOff`.
 * Only a month with some approved leave for that person uses it. Every other
 * date gets undefined, so rollUpDay falls back to the fixed rostered day, which
 * keeps weeks that predate the leave feature computing as they always did.
 */
export function scheduledOffLookup(
  leaveRows: ApprovedLeaveRow[],
): (userId: string, date: string) => boolean | undefined {
  const approved = new Set(leaveRows.map((l) => `${l.user_id}|${l.leave_date}`));
  const leaveMonths = new Set(leaveRows.map((l) => `${l.user_id}|${l.leave_date.slice(0, 7)}`));
  return (userId, date) =>
    leaveMonths.has(`${userId}|${date.slice(0, 7)}`) ? approved.has(`${userId}|${date}`) : undefined;
}
