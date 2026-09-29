import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { istDateIso } from '@/lib/api/date';
import { dueReports, resolveRecipients } from '@/lib/reports/ownerDigest';
import {
  MIGRATION_NOT_APPLIED,
  buildDigest,
  loadReportSettings,
  logSend,
  ownerLoginEmails,
  sendDigest,
  type SendOutcome,
} from '@/lib/reports/ownerDigestServer';

export const dynamic = 'force-dynamic';
// A monthly report reads two months of orders plus their lines.
export const maxDuration = 60;

// GET /api/cron/owner-reports — Vercel Cron, daily 08:00 IST.
//   vercel.json → { "path": "/api/cron/owner-reports", "schedule": "30 2 * * *" }
// Emails the owner yesterday's report, and on the owner's chosen days the
// weekly and monthly ones (lib/reports/ownerDigest.ts dueReports). Settings:
// Owner → Reports. Safe to run twice — a report already sent for a period is
// not sent again.
//
// Protected by CRON_SECRET (Bearer), fails CLOSED like every other cron.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const admin = createAdminSupabaseClient();
  let loaded;
  try {
    loaded = await loadReportSettings(admin);
  } catch (err) {
    console.error('owner-reports cron: settings load failed', err);
    return errorResponse(500, 'Could not read report settings');
  }
  // Never send on defaults the owner has never seen.
  if (!loaded.migrated) return NextResponse.json({ ok: true, sent: 0, note: MIGRATION_NOT_APPLIED });

  const today = istDateIso();
  const due = dueReports(today, loaded.settings);
  if (due.length === 0) return NextResponse.json({ ok: true, today, sent: 0, note: 'no reports due' });

  const recipients = resolveRecipients(loaded.settings, await ownerLoginEmails(admin));
  if (recipients.length === 0) {
    return NextResponse.json({ ok: true, today, sent: 0, note: 'no recipients configured' });
  }

  const results: { kind: string; from: string; to: string; outcomes: SendOutcome[]; error?: string }[] = [];
  for (const period of due) {
    try {
      const digest = await buildDigest(admin, period);
      if (period.kind === 'daily' && loaded.settings.daily_skip_empty && digest.empty) {
        const outcomes = recipients.map((to) => ({ to, status: 'skipped' as const, detail: 'no orders or payments that day' }));
        for (const o of outcomes) await logSend(admin, period, 'cron', o);
        results.push({ ...period, outcomes });
        continue;
      }
      results.push({ ...period, outcomes: await sendDigest(admin, period, digest.email, recipients, 'cron') });
    } catch (err) {
      // One report failing to build must not stop the others.
      console.error('owner-reports cron: build failed', period, err);
      results.push({ ...period, outcomes: [], error: err instanceof Error ? err.message : 'build failed' });
    }
  }

  const sent = results.reduce((n, r) => n + r.outcomes.filter((o) => o.status === 'sent').length, 0);
  return NextResponse.json({ ok: true, today, sent, results });
}
