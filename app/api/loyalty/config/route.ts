import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { getLoyaltyConfig } from '@/lib/loyalty/ledger';
import type { LoyaltyConfig } from '@/lib/types';

export const dynamic = 'force-dynamic';

const WRITABLE_NUMERIC_FIELDS = [
  'points_per_inr',
  'inr_per_point',
  'min_redeem_points',
  'max_redeem_pct',
  'points_expiry_days',
] as const;

// GET /api/loyalty/config — public. Powers the "how points work" copy on the
// Rewards page and the checkout's redemption UI. Null if the singleton row
// hasn't been seeded yet (migration not applied).
export async function GET() {
  const config = await getLoyaltyConfig();
  return NextResponse.json({ config });
}

// PATCH /api/loyalty/config — staff/owner only. Edits the singleton loyalty
// config row (earn/redeem rates, limits, expiry).
export async function PATCH(request: Request) {
  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const patch: Record<string, number | boolean> = {};
  for (const field of WRITABLE_NUMERIC_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return errorResponse(400, `${field} must be a non-negative number`);
    }
    patch[field] = value;
  }
  if (body.enrolled_by_default !== undefined) {
    if (typeof body.enrolled_by_default !== 'boolean') {
      return errorResponse(400, 'enrolled_by_default must be a boolean');
    }
    patch.enrolled_by_default = body.enrolled_by_default;
  }
  if (Object.keys(patch).length === 0) {
    return errorResponse(400, 'No writable settings fields provided');
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('loyalty_config')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('is_singleton', true)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('loyalty_config update failed', error);
    return errorResponse(500, 'Failed to update loyalty config');
  }
  if (!data) {
    return errorResponse(500, 'Loyalty config row not found');
  }

  return NextResponse.json({ config: data as LoyaltyConfig });
}
