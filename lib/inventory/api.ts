// Shared gate and error mapping for app/api/inventory/** (docs/INVENTORY-SPEC.md).

import 'server-only';
import type { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { flags } from '@/lib/flags';
import { inventoryErrorMessage, isManagerRole } from '@/lib/inventory/rules';
import { INVENTORY_MIGRATION_HINT, INVENTORY_OFF_MESSAGE } from '@/lib/inventory/server';
import type { UserRole } from '@/lib/types';

export interface InventoryActor {
  user: User;
  role: UserRole;
  isManager: boolean;
}

/**
 * Any counter actor (classic staff session, or an enrolled device's PIN
 * operator — a device-unlocked owner is already capped to 'manager'), with
 * the inventory flag on. `managerOnly` refuses plain staff.
 */
export async function requireInventoryActor(
  { managerOnly = false }: { managerOnly?: boolean } = {},
): Promise<{ actor: InventoryActor } | { response: NextResponse }> {
  const actor = await getCounterActor();
  if (!actor) return { response: unauthorized() };
  if (!flags.inventory) return { response: errorResponse(404, INVENTORY_OFF_MESSAGE) };
  const isManager = isManagerRole(actor.role);
  if (managerOnly && !isManager) {
    return { response: errorResponse(403, 'Only a manager or the owner can do this.') };
  }
  return { actor: { user: actor.user, role: actor.role, isManager } };
}

/** A failed write: the database function's own message → 409; a duplicate →
 * 409; a missing referenced row → 400; anything else → 500 with the
 * migration hint (the usual cause on a fresh deploy). */
export function inventoryWriteFailure(
  error: { code?: string; message?: string } | null,
  what: string,
): NextResponse {
  const friendly = inventoryErrorMessage(error);
  if (friendly) return errorResponse(409, friendly);
  if (error?.code === '23505') return errorResponse(409, `${what}: that already exists.`);
  if (error?.code === '23503') return errorResponse(400, `${what}: it refers to something that no longer exists.`);
  if (error?.code === '23514') return errorResponse(400, `${what}: a value is out of range.`);
  console.error(`inventory: ${what} failed`, error);
  return errorResponse(500, `${what} failed — ${INVENTORY_MIGRATION_HINT}`);
}
