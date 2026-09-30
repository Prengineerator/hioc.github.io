import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { coffeePassDisabled, isMissingPassSchema, PASS_MIGRATION_HINT } from '@/lib/passes/api';

export const dynamic = 'force-dynamic';

const MAX_IDS = 500;
/** Ids per `.in()` filter: keeps the request URL well under a proxy's limit. */
const CHUNK = 100;

// PUT /api/owner/passes/eligible — owner only. Body: { menu_item_ids: string[] }.
// REPLACES the set of drinks a pass can pay for (CP-D3): every listed item becomes
// pass_eligible, every other item stops being. Responds { eligible_ids }.
//
// It is a replace, not a toggle, because that is what the picker holds: the whole
// ticked set, with "select the whole category" as a shortcut. An empty list is
// valid (nothing eligible: a pass then covers nothing). The list is deduplicated;
// more than 500 ids, a value that is not an id, or an id that is not on the menu is
// a 400 and NOTHING changes.
//
// Only the rows that actually change are written, and the un-ticks go first: if a
// write fails half way the eligible set is left SMALLER than asked for, never
// larger, so a failure can only make a pass cover less, not more. The same request
// again finishes the job (it is idempotent).
//
// Which drinks a pass covers is the owner's decision (§9 B2), not a counter
// permission: getOwnerUser() ONLY (rule D6-6).
export async function PUT(request: Request) {
  const off = coffeePassDisabled();
  if (off) return off;

  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const raw = body.menu_item_ids;
  if (!Array.isArray(raw)) return errorResponse(400, 'menu_item_ids must be a list of menu item ids');
  if (raw.length > MAX_IDS) return errorResponse(400, `Choose at most ${MAX_IDS} drinks.`);
  if (!raw.every((id) => isUuid(id))) return errorResponse(400, 'menu_item_ids must all be menu item ids');
  const wanted = new Set((raw as string[]).map((id) => id.toLowerCase()));

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('menu_items').select('id, pass_eligible');
  if (error) return failure(error, 'Could not read the menu.');
  const menu = (data ?? []) as { id: string; pass_eligible: boolean }[];

  const onMenu = new Set(menu.map((m) => m.id.toLowerCase()));
  for (const id of wanted) {
    if (!onMenu.has(id)) return errorResponse(400, 'One of those drinks is no longer on the menu — refresh and try again.');
  }

  const eligibleNow = new Set(menu.filter((m) => m.pass_eligible === true).map((m) => m.id.toLowerCase()));
  const toDisable = [...eligibleNow].filter((id) => !wanted.has(id));
  const toEnable = [...wanted].filter((id) => !eligibleNow.has(id));

  for (const [value, ids] of [[false, toDisable], [true, toEnable]] as const) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error: writeError } = await admin
        .from('menu_items')
        .update({ pass_eligible: value })
        .in('id', ids.slice(i, i + CHUNK));
      if (writeError) return failure(writeError, 'Could not save the drinks — please try again.');
    }
  }

  return NextResponse.json({ eligible_ids: menu.map((m) => m.id).filter((id) => wanted.has(id.toLowerCase())) });
}

function failure(error: { code?: string; message?: string }, message: string) {
  console.error('PUT /api/owner/passes/eligible: failed', error);
  return errorResponse(500, isMissingPassSchema(error) ? `${message.replace(/\.$/, '')} — ${PASS_MIGRATION_HINT}` : message);
}
