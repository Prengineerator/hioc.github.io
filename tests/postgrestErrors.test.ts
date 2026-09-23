import { describe, expect, it } from 'vitest';

// The two shapes of "that column isn't there", both confirmed against the live
// database. This test exists because the obvious single-code check (42703) is
// correct for reads and silently never fires on writes — and the mocked suite
// can see neither, so the codes are pinned here in plain text instead.

import { isMissingColumnError } from '@/lib/api/postgrest';

describe('isMissingColumnError', () => {
  it('recognises a SELECT against a missing column (Postgres, 42703)', () => {
    expect(
      isMissingColumnError({ code: '42703', message: 'column orders.customer_user_id does not exist' }),
    ).toBe(true);
  });

  it('recognises an INSERT/UPDATE naming one (PostgREST, PGRST204)', () => {
    expect(
      isMissingColumnError({
        code: 'PGRST204',
        message: "Could not find the 'customer_user_id' column of 'orders' in the schema cache",
      }),
    ).toBe(true);
  });

  it('falls back to the message when a response carries no code', () => {
    expect(isMissingColumnError({ message: 'column orders.customer_user_id does not exist' })).toBe(true);
    expect(
      isMissingColumnError({ message: "Could not find the 'x' column of 'orders' in the schema cache" }),
    ).toBe(true);
  });

  it('does not swallow a real failure', () => {
    // Every one of these must keep failing loudly rather than degrading to a
    // "migration pending" path that quietly drops data.
    expect(isMissingColumnError({ code: '23503', message: 'violates foreign key constraint' })).toBe(false);
    expect(isMissingColumnError({ code: '23514', message: 'violates check constraint' })).toBe(false);
    expect(isMissingColumnError({ code: '42P01', message: 'relation "orders" does not exist' })).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
    expect(isMissingColumnError(undefined)).toBe(false);
    expect(isMissingColumnError({})).toBe(false);
  });
});
