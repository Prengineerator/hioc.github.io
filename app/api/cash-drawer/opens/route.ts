import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor, getManagerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getEnrolledDevice } from '@/lib/api/device';
import { startOfTodayIstIso } from '@/lib/api/date';
import { getStaffDisplayNames } from '@/lib/staff/displayName';

export const dynamic = 'force-dynamic';

// DRW-2 — the cash-drawer log (supabase/2026-09-cash-drawer-log.sql). One row
// per opening, whether a staffer tapped Cash to take a payment or opened it by
// hand from the POS. An opening with no sale behind it is what a till audit is
// looking for, so the owner sees today's count and the recent list.

const REASONS = ['cash_payment', 'manual'] as const;
type DrawerReason = (typeof REASONS)[number];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MISSING = 'Could not load the drawer log — is supabase/2026-09-cash-drawer-log.sql applied?';

// POST /api/cash-drawer/opens — any counter actor (session or PIN operator).
// Body: { reason: 'cash_payment' | 'manual', order_id?: uuid }. Who and which
// counter come from the request's own session and device cookie, never the body.
export async function POST(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const { reason, order_id } = body;
  if (typeof reason !== 'string' || !REASONS.includes(reason as DrawerReason)) {
    return errorResponse(400, `reason must be one of: ${REASONS.join(', ')}`);
  }
  if (order_id !== undefined && order_id !== null && !isUuid(order_id)) {
    return errorResponse(400, 'order_id must be a uuid');
  }

  const device = await getEnrolledDevice();
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('cash_drawer_opens')
    .insert({
      reason,
      order_id: order_id ?? null,
      opened_by: actor.user.id,
      device_id: device?.id ?? null,
    })
    .select('id, opened_at')
    .single();
  if (error || !data) {
    console.error('cash-drawer/opens: insert failed', error);
    return errorResponse(500, 'Could not log the drawer opening — is supabase/2026-09-cash-drawer-log.sql applied?');
  }

  return NextResponse.json({ open: data }, { status: 201 });
}

// GET /api/cash-drawer/opens?limit= — manager/owner only. Today's counts (IST
// day) by reason, plus the most recent openings with names resolved.
export async function GET(request: Request) {
  const manager = await getManagerUser();
  if (!manager) return unauthorized();

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_LIMIT) : DEFAULT_LIMIT;

  const admin = createAdminSupabaseClient();
  const [recentRes, todayRes] = await Promise.all([
    admin
      .from('cash_drawer_opens')
      .select('id, opened_at, reason, order_id, opened_by, device_id, orders(order_number), pos_devices(name)')
      .order('opened_at', { ascending: false })
      .limit(limit),
    admin.from('cash_drawer_opens').select('reason').gte('opened_at', startOfTodayIstIso()),
  ]);
  if (recentRes.error || todayRes.error) {
    console.error('cash-drawer/opens: lookup failed', recentRes.error ?? todayRes.error);
    return errorResponse(500, MISSING);
  }

  type Embed<T> = T | T[] | null | undefined;
  const one = <T,>(v: Embed<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

  const rows = (recentRes.data ?? []) as unknown as {
    id: string;
    opened_at: string;
    reason: DrawerReason;
    order_id: string | null;
    opened_by: string | null;
    device_id: string | null;
    orders: Embed<{ order_number: number }>;
    pos_devices: Embed<{ name: string }>;
  }[];
  const names = await getStaffDisplayNames(
    admin,
    rows.map((r) => r.opened_by).filter((id): id is string => Boolean(id)),
  );

  const todayRows = (todayRes.data ?? []) as { reason: DrawerReason }[];
  const today = {
    total: todayRows.length,
    cashPayment: todayRows.filter((r) => r.reason === 'cash_payment').length,
    manual: todayRows.filter((r) => r.reason === 'manual').length,
  };

  const opens = rows.map((r) => ({
    id: r.id,
    openedAt: r.opened_at,
    reason: r.reason,
    orderId: r.order_id,
    orderNumber: one(r.orders)?.order_number ?? null,
    openedByName: r.opened_by ? (names.get(r.opened_by) ?? 'Unknown staff') : 'Unknown staff',
    deviceName: one(r.pos_devices)?.name ?? null,
  }));

  return NextResponse.json({ today, opens });
}
