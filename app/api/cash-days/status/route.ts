import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { unauthorized } from '@/lib/api/http';
import { cashDayGateState } from '@/lib/cash/dayServer';

export const dynamic = 'force-dynamic';

// GET /api/cash-days/status — any staff session (PIN-3: or an enrolled
// device's operator). What the counter must do before it takes orders
// (lib/cash/autoEnd.ts): { step: 'close_overdue' | 'open' | null, open_day }.
// Cheap — one read — because the POS asks it on a timer and on focus
// (components/staff/CashDayGate.tsx); the full figures stay on GET /api/cash-days.
export async function GET() {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  const state = await cashDayGateState(createAdminSupabaseClient());
  return NextResponse.json({ step: state.step, open_day: state.openDay });
}
