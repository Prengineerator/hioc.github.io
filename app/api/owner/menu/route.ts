import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { applyMenuCreate, failureResponse, validateCreateBody } from '@/lib/menu/applyMenuChange';

export const dynamic = 'force-dynamic';

// POST /api/owner/menu — owner only. Creates a menu item straight from the
// owner app: same body as POST /api/menu (MenuItemFormValues), same write, no
// approval and no POS device needed. -> 201 { item }.
//
// getOwnerUser() ONLY (rule D6-6): never getCounterActor() — an enrolled
// device's PIN operator must not reach owner routes.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const checked = validateCreateBody(body);
  if (!checked.ok) return failureResponse(checked);

  const created = await applyMenuCreate(createAdminSupabaseClient(), checked.value);
  if (!created.ok) return failureResponse(created);

  return NextResponse.json({ item: created.value }, { status: 201 });
}
