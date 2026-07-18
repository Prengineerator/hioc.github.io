import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isOrderType } from '@/lib/api/constants';
import { normalizeIndianMobile } from '@/lib/phone';
import type { OrderType } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 100;

// Preference keys we recognize inside profiles.prefs (jsonb) — ACC-3.
interface AccountPrefs {
  default_order_type?: OrderType;
  veg_only?: boolean;
}

interface ProfileRow {
  name: string;
  phone: string;
  phone_verified: boolean;
  marketing_consent: boolean;
  prefs: AccountPrefs | null;
}

// Response contract consumed by BOTH app/account/profile (full prefill) and
// the Payments engineer's checkout (name/phone/prefs prefill) — keep this
// shape stable: { name, phone, phone_verified, marketing_consent, prefs }.
function shapeMe(profile: ProfileRow) {
  return {
    name: profile.name,
    phone: profile.phone,
    phone_verified: profile.phone_verified,
    marketing_consent: profile.marketing_consent,
    prefs: profile.prefs ?? {},
  };
}

const EMPTY_PROFILE: ProfileRow = {
  name: '',
  phone: '',
  phone_verified: false,
  marketing_consent: false,
  prefs: {},
};

// GET /api/account/me — the caller's own profile. 401 if not logged in.
export async function GET() {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const admin = createAdminSupabaseClient();
  const { data: profile, error } = await admin
    .from('profiles')
    .select('name, phone, phone_verified, marketing_consent, prefs')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to load profile');
  }

  return NextResponse.json(shapeMe((profile as ProfileRow | null) ?? EMPTY_PROFILE));
}

// PATCH /api/account/me — update the whitelisted profile columns (ACC-3):
// name, marketing_consent, default_order_type + veg_only (inside prefs), and
// phone. NEVER touches `role` — no field named `role` is ever read from the
// body. `phone` is only accepted once it matches the caller's
// Supabase-Auth-verified phone (set via the phone-otp login flow, or the
// native `updateUser({ phone }) + verifyOtp({ type: 'phone_change' })` flow
// the profile page drives client-side) — this route never marks a phone
// verified on its own say-so, it only mirrors what Supabase Auth already
// verified into our `profiles` table.
export async function PATCH(request: Request) {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return errorResponse(400, 'name must be a non-empty string');
    }
    if (body.name.trim().length > MAX_NAME_LENGTH) {
      return errorResponse(400, `name must be at most ${MAX_NAME_LENGTH} characters`);
    }
    updates.name = body.name.trim();
  }

  if (body.marketing_consent !== undefined) {
    if (typeof body.marketing_consent !== 'boolean') {
      return errorResponse(400, 'marketing_consent must be a boolean');
    }
    updates.marketing_consent = body.marketing_consent;
  }

  if (body.phone !== undefined) {
    if (typeof body.phone !== 'string') {
      return errorResponse(400, 'phone must be a string');
    }
    const normalized = normalizeIndianMobile(body.phone);
    if (!normalized) {
      return errorResponse(400, 'phone must be a valid 10-digit Indian mobile number');
    }
    const authPhoneDigits = (user.phone ?? '').replace(/\D/g, '').slice(-10);
    if (authPhoneDigits !== normalized) {
      return errorResponse(400, 'This phone number has not been verified yet.');
    }
    updates.phone = `+91${normalized}`;
    updates.phone_verified = true;
  }

  const admin = createAdminSupabaseClient();

  if (body.default_order_type !== undefined || body.veg_only !== undefined) {
    if (body.default_order_type !== undefined && !isOrderType(body.default_order_type)) {
      return errorResponse(400, 'default_order_type must be takeaway, dine_in, or delivery');
    }
    if (body.veg_only !== undefined && typeof body.veg_only !== 'boolean') {
      return errorResponse(400, 'veg_only must be a boolean');
    }

    const { data: existing } = await admin
      .from('profiles')
      .select('prefs')
      .eq('id', user.id)
      .maybeSingle();

    const nextPrefs: AccountPrefs = { ...((existing?.prefs as AccountPrefs | null) ?? {}) };
    if (body.default_order_type !== undefined) {
      nextPrefs.default_order_type = body.default_order_type as OrderType;
    }
    if (body.veg_only !== undefined) {
      nextPrefs.veg_only = body.veg_only as boolean;
    }
    updates.prefs = nextPrefs;
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse(400, 'No valid fields to update');
  }

  const { data: updated, error } = await admin
    .from('profiles')
    .update(updates)
    .eq('id', user.id)
    .select('name, phone, phone_verified, marketing_consent, prefs')
    .single();

  if (error || !updated) {
    return errorResponse(500, 'Failed to update profile');
  }

  return NextResponse.json(shapeMe(updated as ProfileRow));
}
