import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';
import { coffeePassDisabled, isMissingPassSchema, PASS_MIGRATION_HINT } from '@/lib/passes/api';
import {
  buildPassSummary,
  parseSummaryRange,
  SUMMARY_PASS_COLUMNS,
  SUMMARY_RECENT_LIMIT,
  summaryRangeBounds,
  toSummaryPassRow,
  type SummaryHolder,
  type SummaryRedemptionRow,
} from '@/lib/passes/summary';

export const dynamic = 'force-dynamic';

const VIEW = 'v_coffee_pass_balances';
/** PostgREST returns at most 1000 rows a request, so a big range is read a page at a time. */
const PAGE = 1000;
const MAX_PAGES = 30;

type PageResult = PromiseLike<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>;

/** Reads every page of a query (`page(from, to)` is the inclusive row range). */
async function readAll(page: (from: number, to: number) => PageResult) {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, i * PAGE + PAGE - 1);
    if (error) return { rows, error };
    const got = (data ?? []) as Record<string, unknown>[];
    rows.push(...got);
    if (got.length < PAGE) break;
  }
  return { rows, error: null };
}

// GET /api/owner/passes/summary?from=YYYY-MM-DD&to=YYYY-MM-DD — owner only.
// The HIOC Ritual numbers for the owner page. `from`/`to` are IST calendar days,
// both inclusive; with neither it is the last 30 days including today. A date
// that is not real, a start after the end, an end in the future and a window
// over 366 days are 400s (the same checks as the reports).
//
// Responds { range, sold, sold_by_plan, refunded, active, redeemed,
// expired_unused, recent }; what each one means, and the rounding, is written
// where it is computed (lib/passes/summary.ts buildPassSummary). This route only
// fetches the rows and hands them over:
//   - passes created in the range, and passes still 'active' that expire on or
//     after its start (for sold / refunded / active / expired unused),
//   - the non-reversed redemptions in the range,
//   - the 20 newest passes overall, with their holders' name and phone (the phone
//     leaves here already masked to its last four digits).
//
// getOwnerUser() ONLY (rule D6-6).
export async function GET(request: Request) {
  const off = coffeePassDisabled();
  if (off) return off;

  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const url = new URL(request.url);
  const now = new Date();
  const range = parseSummaryRange(url.searchParams.get('from'), url.searchParams.get('to'), now);
  if (!range.ok) return errorResponse(400, range.message);
  const { startIso, endIso } = summaryRangeBounds(range.from, range.to);

  const admin = createAdminSupabaseClient();
  const [created, live, redemptions, newest] = await Promise.all([
    readAll((a, b) =>
      admin
        .from(VIEW)
        .select(SUMMARY_PASS_COLUMNS)
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(a, b),
    ),
    readAll((a, b) =>
      admin
        .from(VIEW)
        .select(SUMMARY_PASS_COLUMNS)
        .eq('status', 'active')
        .gte('expires_at', startIso)
        .order('expires_at', { ascending: true })
        .order('id', { ascending: true })
        .range(a, b),
    ),
    readAll((a, b) =>
      admin
        .from('coffee_pass_redemptions')
        .select('drinks, covered_inr, created_at, reversed_at')
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .is('reversed_at', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(a, b),
    ),
    admin
      .from(VIEW)
      .select(SUMMARY_PASS_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(SUMMARY_RECENT_LIMIT),
  ]);

  const failed = created.error ?? live.error ?? redemptions.error ?? newest.error;
  if (failed) {
    console.error('GET /api/owner/passes/summary: read failed', failed);
    return errorResponse(
      500,
      isMissingPassSchema(failed)
        ? `Could not build the summary — ${PASS_MIGRATION_HINT}`
        : 'Could not build the summary.',
    );
  }

  const recent = ((newest.data ?? []) as Record<string, unknown>[]).map(toSummaryPassRow);

  // Who holds the recent passes. A failed read only costs the names ("Customer").
  const holders: Record<string, SummaryHolder> = {};
  const holderIds = [...new Set(recent.map((p) => p.user_id))];
  if (holderIds.length > 0) {
    const { data, error } = await admin.from('profiles').select('id, name, phone').in('id', holderIds);
    if (error) console.error('GET /api/owner/passes/summary: holder names failed', error);
    for (const p of (data ?? []) as { id: string; name: string | null; phone: string | null }[]) {
      holders[p.id] = { name: p.name ?? '', phone: p.phone ?? '' };
    }
  }

  const summary = buildPassSummary({
    passes: [...created.rows, ...live.rows].map(toSummaryPassRow),
    redemptions: redemptions.rows.map(
      (r): SummaryRedemptionRow => ({
        drinks: Number(r.drinks) || 0,
        covered_inr: Number(r.covered_inr) || 0,
        created_at: String(r.created_at),
        reversed_at: r.reversed_at ? String(r.reversed_at) : null,
      }),
    ),
    recent,
    holders,
    from: range.from,
    to: range.to,
    now,
  });
  return NextResponse.json(summary);
}
