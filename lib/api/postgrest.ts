// Reading PostgREST errors, for the one case this codebase keeps meeting: a
// column that a deploy expects and the database does not have yet.
//
// It is worth a module because the answer is NOT one code, and the difference
// is invisible from the application:
//
//   SELECT naming an unknown column  -> 42703   ("column x does not exist")
//                                       Postgres itself refuses the statement.
//   INSERT/UPDATE naming one         -> PGRST204 ("Could not find the 'x'
//                                       column of 'orders' in the schema cache")
//                                       PostgREST refuses it before Postgres
//                                       ever sees it, so there is no SQLSTATE.
//
// Both were confirmed against the live database. Branching on 42703 alone —
// the obvious thing to write, and what the read path legitimately returns —
// silently never fires on the write path, which is the path where a fallback
// actually matters. The vitest suite mocks Supabase and cannot see either.

export interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
}

/**
 * True when the failure is "that column isn't there", from either side of the
 * stack. Callers use it to degrade a pending-migration deploy to the older
 * behaviour rather than failing the request outright.
 */
export function isMissingColumnError(error: PostgrestLikeError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  // The message is only a fallback, for a response that carried no code at all.
  const message = error.message ?? '';
  return /column .* does not exist/i.test(message) || /could not find the .* column of/i.test(message);
}
