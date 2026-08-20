import { NextResponse } from 'next/server';
import { getStaffUser } from '@/lib/api/auth';
import { unauthorized } from '@/lib/api/http';
import { getEnrolledDevice, touchDeviceSeen } from '@/lib/api/device';
import type { PosDeviceContext } from '@/lib/types';

export const dynamic = 'force-dynamic';

// DEV-2/DEV-3 — "which machine am I, and what are my defaults?"
//
// Read once by the POS at boot. Staff-gated, not public: a device name is a fact
// about the cafe's floor ("Event stand", "Back office"), and the answer is only
// ever useful to someone who is already behind the counter.
//
// `{ device: null }` is a normal answer, not an error — a personal phone, a
// browser that cleared its cookies, and a revoked till all land here, and all
// three must keep selling with the store-level defaults.
//
// This is NOT an authorisation check. The device cookie grants nothing; the
// staff session above is what let this request through. From PIN-3 the same
// cookie also gates the operator-switch surface, and the authority there comes
// from the operator's PIN, not from being a known machine.
export async function GET() {
  const user = await getStaffUser();
  if (!user) return unauthorized();

  const device = await getEnrolledDevice();
  if (!device) return NextResponse.json({ device: null });

  // Awaited, not fired and forgotten: an un-awaited promise in a serverless
  // function is routinely killed when the response is returned. It writes at
  // most once an hour per device (SEEN_STALE_MS), so this costs nothing on the
  // boot path in practice.
  await touchDeviceSeen(device);

  const context: PosDeviceContext = {
    id: device.id,
    name: device.name,
    default_order_type: device.default_order_type,
    auto_print_kot: device.auto_print_kot,
    auto_print_bill: device.auto_print_bill,
  };
  return NextResponse.json({ device: context });
}
