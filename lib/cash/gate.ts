import 'server-only';

// The manager/owner gate for cash routes the POS itself must be able to call.
//
// The POS runs with PIN operators on an enrolled device, which have NO classic
// Supabase session — getManagerUser() (session-only) 401'd every one of their
// requests, so cash-in / cash-out (and overrides) could never be recorded from
// the counter: production has zero cash_movements rows, which is part of why
// expected cash never matched. getCounterManager() resolves a session first and
// an enrolled device's PIN operator otherwise (a device operator's role is
// already capped at 'manager').
//
// 401 means "no actor at all" (sign in / unlock the device); 403 means a
// signed-in plain staffer, with a message the form can show as-is.
//
// "Manager" here is the ROLE (manager or owner) — the same predicate as
// lib/cash/dayState.ts isCashManagerRole, which the cash-day routes use for the
// reopen and the unpaid-order override. Closing a day is a different question
// (the cash_day_close permission, which the owner can retune).

import { NextResponse } from 'next/server';
import { getCounterActor, getCounterManager } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';

export type CashManagerActor = NonNullable<Awaited<ReturnType<typeof getCounterManager>>>;

export async function requireCashManager(
  forbiddenMessage: string,
): Promise<{ manager: CashManagerActor; denied?: undefined } | { manager?: undefined; denied: NextResponse }> {
  const manager = await getCounterManager();
  if (manager) return { manager };
  const actor = await getCounterActor();
  return { denied: actor ? errorResponse(403, forbiddenMessage) : unauthorized() };
}
