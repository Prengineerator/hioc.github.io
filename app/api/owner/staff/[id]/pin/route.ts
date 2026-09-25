import { randomInt } from 'crypto';
import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getPinState, isMissingPinTable, setPin, unlockPin } from '@/lib/staff/pinAuth';
import { PIN_LENGTH, pinFormatMessage, pinFormatProblem } from '@/lib/staff/pinPolicy';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

/** A random PIN that already passes pinFormatProblem() (never trivial) — for
 * "generate one for me" on the owner's set/reset form. Rejection sampling: a
 * 4-digit keyspace has very few trivial patterns (repeats, runs, birth
 * years), so this converges in a handful of tries, never enough to matter. */
function randomValidPin(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = String(randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
    if (!pinFormatProblem(pin)) return pin;
  }
  // Unreachable in practice, but never loop forever.
  return '7392';
}

// GET /api/owner/staff/[id]/pin — PIN-5 "see lock state". Never the PIN or
// its hash — hasPin/locked/retryAfterSeconds only.
export async function GET(_request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const state = await getPinState(id);
  if (state === null) {
    return errorResponse(409, 'PIN migration not applied yet — run supabase/2026-08-staff-pins.sql');
  }
  return NextResponse.json(state);
}

// POST /api/owner/staff/[id]/pin — PIN-5 set/reset. Body: { pin?: string }.
// Owner types one (validated the same way the pure policy lib would reject a
// trivial one) or leaves it blank to have one generated. The PIN is returned
// ONCE, in this response, and never again — nothing else ever reads it back.
export async function POST(request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  if (body === null) return errorResponse(400, 'Request body must be a JSON object');

  let pin: string;
  if (body.pin === undefined || body.pin === null || body.pin === '') {
    pin = randomValidPin();
  } else if (typeof body.pin !== 'string') {
    return errorResponse(400, 'pin must be a string');
  } else {
    const problem = pinFormatProblem(body.pin);
    if (problem) return errorResponse(400, pinFormatMessage(problem));
    pin = body.pin;
  }

  // 'reset' vs 'set' for the audit trail (PIN-5) — read the current state
  // first so the row's own history says which this was, not a guess.
  const before = await getPinState(id);
  if (before === null) {
    return errorResponse(409, 'PIN migration not applied yet — run supabase/2026-08-staff-pins.sql');
  }
  const action = before.hasPin ? 'reset' : 'set';

  const result = await setPin(id, pin, owner.id, action);
  if (!result.ok) {
    return errorResponse(isMissingPinTable({ message: result.error }) ? 409 : 500, result.error);
  }

  return NextResponse.json({ ok: true, pin, action });
}

// DELETE /api/owner/staff/[id]/pin — PIN-5 "unlock early". Clears a lockout
// without changing the PIN itself.
export async function DELETE(_request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const result = await unlockPin(id, owner.id);
  if (!result.ok) {
    return errorResponse(isMissingPinTable({ message: result.error }) ? 409 : 500, result.error);
  }
  return NextResponse.json({ ok: true });
}
