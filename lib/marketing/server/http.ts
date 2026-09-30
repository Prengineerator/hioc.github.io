// The shared frame of every owner marketing route (spec §6): owner-only (401 for
// anyone else), a typed 409 when the marketing migration is not applied, and one
// place that decides what an unexpected failure looks like. Modelled on
// app/api/owner/report-emails/route.ts.

import 'server-only';
import type { User } from '@supabase/supabase-js';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { isMigrationMissingError } from './repo';

/** The body of the 409 every owner route answers when a marketing table is absent. */
export const MIGRATION_MISSING = 'migration_missing';

/**
 * Runs `handler` for the signed-in OWNER (getOwnerUser: 401 otherwise). A missing
 * migration becomes 409 `{error:'migration_missing'}`; any other failure is logged and
 * answered as a bare 500 — the message stays in the server log, not in the response.
 */
export async function ownerRoute(handler: (owner: User) => Promise<Response>): Promise<Response> {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();
  try {
    return await handler(owner);
  } catch (err) {
    if (isMigrationMissingError(err)) return errorResponse(409, MIGRATION_MISSING);
    console.error('owner marketing route failed', err);
    return errorResponse(500, 'Something went wrong');
  }
}

/** A UUID, for the [id] segments (anything else is a plain 404, not a database error). */
export const isUuidParam = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
