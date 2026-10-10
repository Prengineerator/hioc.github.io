import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { cashDayEndsAt, isCashDayOverdue } from '@/lib/cash/autoEnd';
import { getOpenDay, isMissingColumn, markDayAutoEnded } from '@/lib/cash/dayServer';

export const dynamic = 'force-dynamic';

// GET /api/cron/end-cash-day — Vercel Cron, daily 03:05 IST.
//   vercel.json → { "path": "/api/cron/end-cash-day", "schedule": "35 21 * * *" }
//
// Ends a cash day nobody closed (lib/cash/autoEnd.ts). The day already ENDS at
// 3:00 am by rule — its figures stop there, and the counter asks the next
// person who logs in to count it and close it — so this job only RECORDS that
// it ended on its own (cash_days.auto_ended_at, 2026-10-cash-day-auto-end.sql),
// for the owner's 8 am report and the cash day log. Nothing is counted or
// closed here: only a person can count the drawer.
//
// Five minutes past the hour so the run never lands a moment before the 3:00
// end. Daily, like every cron here (see /api/cron/close-attendance on why).
// Safe to run twice: a day already marked is left alone. Protected by
// CRON_SECRET and fails CLOSED when it is unset.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const admin = createAdminSupabaseClient();
  const { day, error } = await getOpenDay(admin);
  if (error) {
    if (isMissingColumn(error)) return NextResponse.json({ ok: true, ended: 0, note: 'cash day not set up' });
    console.error('end-cash-day cron: could not read the open day', error);
    return errorResponse(500, 'Could not read the open cash day');
  }
  if (!day || !isCashDayOverdue(day, Date.now())) {
    return NextResponse.json({ ok: true, ended: 0, note: day ? 'the open day has not ended yet' : 'no open day' });
  }

  const endedAt = cashDayEndsAt(day.business_date);
  const recorded = await markDayAutoEnded(admin, day.id, endedAt);
  return NextResponse.json({
    ok: true,
    ended: 1,
    day: { id: day.id, business_date: day.business_date, ended_at: endedAt },
    ...(recorded ? {} : { note: 'apply supabase/2026-10-cash-day-auto-end.sql to record it' }),
  });
}
