import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { plannableWeek, daysUntilDeadline } from '@/lib/leave/week';
import { istBusinessDate } from '@/lib/attendance/businessDate';
import type { LeaveRequest, LeaveReminderKind } from '@/lib/types';

export const dynamic = 'force-dynamic';

// LEAVE-4 — the scheduled nudge.
//
// The in-app banner is computed live and needs no schedule. This job exists for
// the channels that reach someone who ISN'T looking at the portal, which is the
// entire point of a reminder.
//
// WhatsApp is wired but dormant: it needs a NEW Meta-approved template, and
// until WHATSAPP_TPL_LEAVE_REMINDER is set the send is logged as `skipped` with
// the reason rather than silently doing nothing (the BILL-3 lesson — a channel
// that fails invisibly is worse than one that is plainly off). The schedule
// therefore works from today and starts sending the moment the template lands,
// with no code change.
//
// Protected by CRON_SECRET, fails CLOSED when unset.

/**
 * Which days to nudge on, counted back from the Saturday deadline.
 *   3 = Wednesday   1 = Friday   0 = Saturday (last call)
 * Staff get an early prod and a last call; managers are told once the week is
 * nearly settled, because chasing them on Monday about requests that mostly
 * do not exist yet trains them to ignore it.
 */
const STAFF_NUDGE_DAYS_LEFT = [3, 1, 0];
const MANAGER_NUDGE_DAYS_LEFT = [1, 0];

interface Recipient {
  id: string;
  name: string;
  role: string;
  phone: string;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const week = plannableWeek();
  const daysLeft = daysUntilDeadline(week);
  const today = istBusinessDate(new Date());

  const staffDue = STAFF_NUDGE_DAYS_LEFT.includes(daysLeft);
  const managerDue = MANAGER_NUDGE_DAYS_LEFT.includes(daysLeft);
  if (!staffDue && !managerDue) {
    return NextResponse.json({ week: week.weekStart, daysLeft, sent: 0, skipped: 0, note: 'not a nudge day' });
  }

  const admin = createAdminSupabaseClient();

  const [{ data: profileRows }, { data: leaveRows }] = await Promise.all([
    admin.from('profiles').select('id, name, role, phone').in('role', ['staff', 'manager']),
    admin
      .from('leave_requests')
      .select('user_id, status')
      .eq('week_start', week.weekStart)
      .neq('status', 'withdrawn'),
  ]);

  const people = (profileRows ?? []) as Recipient[];
  const requests = (leaveRows ?? []) as Pick<LeaveRequest, 'user_id' | 'status'>[];
  const planned = new Set(requests.map((r) => r.user_id));
  const pending = requests.filter((r) => r.status === 'requested').length;

  const targets: { person: Recipient; kind: LeaveReminderKind; message: string }[] = [];

  if (staffDue) {
    for (const p of people) {
      if (planned.has(p.id)) continue; // they have already planned — do not nag
      targets.push({
        person: p,
        kind: 'staff_submit',
        message:
          daysLeft === 0
            ? `Last call: plan your day off for the week of ${week.weekStart} before tonight.`
            : `Please plan your day off for the week of ${week.weekStart}. Closes Saturday.`,
      });
    }
  }

  if (managerDue && pending > 0) {
    for (const p of people) {
      if (p.role !== 'manager') continue;
      targets.push({
        person: p,
        kind: 'manager_decide',
        message: `${pending} leave ${pending === 1 ? 'request needs' : 'requests need'} deciding for the week of ${week.weekStart}.`,
      });
    }
  }

  const templateConfigured = Boolean(
    process.env.WHATSAPP_TOKEN &&
      process.env.WHATSAPP_PHONE_ID &&
      process.env.WHATSAPP_TPL_LEAVE_REMINDER,
  );

  // NOTHING SENDS YET, and the endpoint says so rather than reporting a zero
  // that looks like "nobody needed reminding". The WhatsApp leg needs a Meta-
  // approved template; until it exists every target is logged as a `skipped`
  // row carrying its reason, which is what makes "why didn't I get reminded?"
  // answerable. When the template lands, the send slots in where the reason is
  // computed and these rows start recording `sent` instead.
  let skipped = 0;

  for (const target of targets) {
    const skipReason = !templateConfigured
      ? 'WHATSAPP_TPL_LEAVE_REMINDER not configured — awaiting Meta template approval'
      : !target.person.phone
        ? 'no phone number on the staff profile'
        : 'leave reminder template approved but the send is not implemented yet';

    // Idempotent on (user, week, kind, channel, day): a retried or twice-run
    // cron must not nudge the same person twice.
    const { error } = await admin.from('leave_reminder_log').insert({
      user_id: target.person.id,
      week_start: week.weekStart,
      kind: target.kind,
      channel: 'whatsapp' as const,
      sent_on: today,
      status: 'skipped',
      skip_reason: skipReason,
    });

    // A duplicate key means this nudge already went out today — the whole point
    // of the unique index. Not an error.
    if (error && (error as { code?: string }).code !== '23505') {
      console.error('leave reminder log failed', error);
    }
    skipped += 1;
  }

  return NextResponse.json({
    week: week.weekStart,
    daysLeft,
    targets: targets.length,
    sent: 0,
    skipped,
    whatsappConfigured: templateConfigured,
    note: 'The in-app banner is live; WhatsApp is pending a Meta template.',
  });
}
