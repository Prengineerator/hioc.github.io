import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { rateLimitOk, clientIp } from '@/lib/api/rateLimit';
import { getEnrolledDevice } from '@/lib/api/device';
import { flags } from '@/lib/flags';
import { verifyPin } from '@/lib/staff/pinAuth';
import { pinFormatProblem } from '@/lib/staff/pinPolicy';
import {
  OPERATOR_COOKIE,
  clearedOperatorCookieOptions,
  operatorCookieOptions,
} from '@/lib/api/operatorCookie';
import { issueOperatorCookieValue, listOperatorOptions, operatorFeatureConfigured } from '@/lib/api/operator';

export const dynamic = 'force-dynamic';

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** With the flag off, the secret missing/short, or no enrolled device, this
 * whole route must behave as if it doesn't exist — the guard rail every PIN-3
 * ticket repeats. A disabled/unreachable route answers 404, not 401/403,
 * which would (truthfully but misleadingly) imply the feature exists and the
 * caller just isn't allowed to use it. */
function disabled() {
  return errorResponse(404, 'PIN switching is not enabled on this counter');
}

// GET /api/device/operator — the lock screen's tile list: names + ids of
// active staff with a PIN set (never PIN or lockout data). Deliberately
// gated on the ENROLLED DEVICE ONLY, with no staff session required — this is
// the one intentional exception to "a device cookie must never authorise
// anything" (docs/SECURITY-PLAYBOOK.md D-1), and it is a narrow one: the
// person standing at a freshly-locked, session-less counter has nothing else
// to tap yet, and needs to SEE whose name to pick before they can prove
// anything with a PIN. What it returns is exactly what PIN-2 describes
// showing pre-authentication (name tiles) and nothing more — no roles, no
// contact info, no lock state. The device itself only exists because an
// owner's full classic session enrolled it (app/staff/device/page.tsx).
export async function GET() {
  if (!flags.pinSwitch || !operatorFeatureConfigured()) return NextResponse.json({ operators: [] });

  const device = await getEnrolledDevice();
  if (!device) return NextResponse.json({ operators: [] });

  const operators = await listOperatorOptions();
  return NextResponse.json({ operators });
}

// POST /api/device/operator — { userId, pin } + the enrolled-device cookie →
// verifies the PIN (PIN-1's server-enforced lockout, from the staff_pins
// row) and, on success, sets the operator cookie (PIN-3). This is the ONLY
// place an operator cookie is ever minted — no classic session is checked or
// required here, by design: the whole point is to authenticate someone who
// has none on this machine.
export async function POST(request: Request) {
  if (!flags.pinSwitch || !operatorFeatureConfigured()) return disabled();

  const device = await getEnrolledDevice();
  if (!device) return disabled();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const userId = typeof body.userId === 'string' ? body.userId : '';
  if (!isUuid(userId)) return errorResponse(400, 'userId is required and must be a valid uuid');

  const pin = typeof body.pin === 'string' ? body.pin : '';
  const format = pinFormatProblem(pin);
  if (format) return errorResponse(400, 'PIN must be 4 digits');

  // Belt-and-braces on top of staff_pins' own row-based lockout (PIN-1): caps
  // attempts per (device, user) regardless of which user id is being tried,
  // so a script iterating every user id on one device still gets throttled.
  const allowed = await rateLimitOk(`operator-verify:${device.id}:${clientIp(request)}`, 20, 300);
  if (!allowed) return errorResponse(429, 'Too many PIN attempts from this counter — please wait a moment.');

  const result = await verifyPin(userId, pin);
  if (!result.ok) {
    switch (result.reason) {
      case 'no_pin':
        return errorResponse(400, 'This person has no PIN set — ask the owner');
      case 'locked':
        return errorResponse(423, `Locked — try again in ${result.retryAfterSeconds}s`);
      case 'wrong_pin':
        return errorResponse(
          401,
          result.retryAfterSeconds > 0
            ? `Wrong PIN — locked for ${result.retryAfterSeconds}s`
            : 'Wrong PIN',
        );
      case 'unavailable':
      default:
        return disabled();
    }
  }

  const issued = issueOperatorCookieValue(userId, device.id);
  if (!issued) return disabled(); // secret vanished between the check above and here

  cookies().set(OPERATOR_COOKIE, issued.value, operatorCookieOptions(isProd()));
  return NextResponse.json({ ok: true });
}

// DELETE /api/device/operator — lock. Always succeeds: clearing a cookie that
// was never set, or that names a device that's since been revoked, is a
// no-op either way, and "lock" must never be something that can itself fail
// closed into staying unlocked.
export async function DELETE() {
  cookies().set(OPERATOR_COOKIE, '', clearedOperatorCookieOptions(isProd()));
  return NextResponse.json({ ok: true });
}
