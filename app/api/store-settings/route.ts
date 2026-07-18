import { NextResponse } from 'next/server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import {
  getStoreSettings,
  sanitizeSettingsPatch,
  updateStoreSettings,
} from '@/lib/store/settings';
import { computeStoreOpenState } from '@/lib/store/hours';

export const dynamic = 'force-dynamic';

// GET /api/store-settings — public. The customer site needs hours/tax/slots and
// the current open/accepting state (C3). RLS also allows anon read of the row,
// but going through the server keeps the shape stable and adds the derived
// open-state so clients don't re-implement the hours math.
export async function GET() {
  const settings = await getStoreSettings();
  const openState = computeStoreOpenState(settings);
  return NextResponse.json({ settings, openState });
}

// PATCH /api/store-settings — staff/owner only (S7 busy-mode + O5 owner UI).
// Only the whitelisted writable keys are applied; id/is_singleton are ignored.
export async function PATCH(request: Request) {
  const user = await getStaffUser(); // getStaffUser accepts staff OR owner
  if (!user) {
    return unauthorized();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const patch = sanitizeSettingsPatch(body);
  if (Object.keys(patch).length === 0) {
    return errorResponse(400, 'No writable settings fields provided');
  }

  const updated = await updateStoreSettings(patch);
  if (!updated) {
    return errorResponse(500, 'Failed to update store settings');
  }

  return NextResponse.json({
    settings: updated,
    openState: computeStoreOpenState(updated),
  });
}
