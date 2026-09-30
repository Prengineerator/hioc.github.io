// Shared gate and error reading for app/api/passes/** and app/api/owner/passes/**
// (docs/COFFEE-PASS-SPEC.md §7). Mirrors lib/inventory/api.ts.

import 'server-only';
import type { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/http';
import { isMissingColumnError, type PostgrestLikeError } from '@/lib/api/postgrest';
import { flags } from '@/lib/flags';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';

/** Appended to a 500 / a log line when the usual cause is a database without the migration. */
export const PASS_MIGRATION_HINT = 'is supabase/2026-10-coffee-pass.sql applied?';

export const PASS_OFF_MESSAGE = `${PASS_PROGRAM_NAME} is not switched on for this environment.`;

/**
 * Every pass route starts with this: a 404 while NEXT_PUBLIC_FLAG_COFFEE_PASS
 * is off (the default), so the feature does not exist until the owner has made
 * the spec's §9 B decisions, and null when the route may go on.
 *
 *   const off = coffeePassDisabled();
 *   if (off) return off;
 */
export function coffeePassDisabled(): NextResponse | null {
  return flags.coffeePass ? null : errorResponse(404, PASS_OFF_MESSAGE);
}

/**
 * True when the failure is "the pass schema is not there": a missing table or
 * view (Postgres 42P01, or PostgREST's PGRST205 for its schema cache), a
 * missing column (42703 / PGRST204, see lib/api/postgrest.ts for why the write
 * path differs from the read path), or a missing function (42883 / PGRST202).
 * A pending-migration deploy reads this and answers with PASS_MIGRATION_HINT
 * instead of an unexplained 500.
 */
export function isMissingPassSchema(error: PostgrestLikeError | null | undefined): boolean {
  if (!error) return false;
  if (isMissingColumnError(error)) return true;
  const code = error.code ?? '';
  if (code === '42P01' || code === 'PGRST205' || code === '42883' || code === 'PGRST202') return true;
  // The message is only a fallback, for a response that carried no code at all.
  const message = error.message ?? '';
  return (
    /relation .* does not exist/i.test(message) ||
    /could not find the table/i.test(message) ||
    /could not find the function/i.test(message) ||
    /function .* does not exist/i.test(message)
  );
}
