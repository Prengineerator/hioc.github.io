import { describe, expect, it } from 'vitest';
import {
  istToday,
  parseIsoDate,
  prefillProfileFromPetpooja,
  profilePrefillToUpdate,
} from '@/lib/legacy/account';
import type { SupabaseClient } from '@supabase/supabase-js';

// Pure functions for profile pre-fill from Petpooja legacy data — no Supabase
// mocks, just the business logic of "which fields should be updated given
// the current profile state and legacy data".

describe('profilePrefillToUpdate', () => {
  it('fills an empty name from legacy data', () => {
    const updates = profilePrefillToUpdate(
      '',
      null,
      null,
      { name: 'Alice' },
    );
    expect(updates).toEqual({ name: 'Alice' });
  });

  it('does not overwrite a non-empty profile name', () => {
    const updates = profilePrefillToUpdate(
      'Bob',
      null,
      null,
      { name: 'Alice' },
    );
    expect(updates).toEqual({});
  });

  it('skips whitespace-only profile names and fills from legacy', () => {
    const updates = profilePrefillToUpdate(
      '   ',
      null,
      null,
      { name: 'Charlie' },
    );
    expect(updates).toEqual({ name: 'Charlie' });
  });

  it('fills a null date_of_birth from legacy data', () => {
    const updates = profilePrefillToUpdate(
      'Alice',
      null,
      null,
      { date_of_birth: '1990-05-15' },
    );
    expect(updates).toEqual({ date_of_birth: '1990-05-15' });
  });

  it('does not overwrite an existing date_of_birth', () => {
    const updates = profilePrefillToUpdate(
      'Alice',
      '1995-10-20',
      null,
      { date_of_birth: '1990-05-15' },
    );
    expect(updates).toEqual({});
  });

  it('fills a null date_of_anniversary from legacy data', () => {
    const updates = profilePrefillToUpdate(
      'Alice',
      null,
      null,
      { date_of_anniversary: '2015-06-10' },
    );
    expect(updates).toEqual({ date_of_anniversary: '2015-06-10' });
  });

  it('does not overwrite an existing date_of_anniversary', () => {
    const updates = profilePrefillToUpdate(
      'Alice',
      null,
      '2010-03-25',
      { date_of_anniversary: '2015-06-10' },
    );
    expect(updates).toEqual({});
  });

  it('fills multiple fields at once when all are empty', () => {
    const updates = profilePrefillToUpdate(
      '',
      null,
      null,
      {
        name: 'Diana',
        date_of_birth: '1988-12-01',
        date_of_anniversary: '2012-07-04',
      },
    );
    expect(updates).toEqual({
      name: 'Diana',
      date_of_birth: '1988-12-01',
      date_of_anniversary: '2012-07-04',
    });
  });

  it('only fills fields that are both in legacy data and blank in profile', () => {
    const updates = profilePrefillToUpdate(
      'Eve',
      null,
      '2008-01-15',
      {
        name: 'Frank',
        date_of_birth: '1985-02-28',
        date_of_anniversary: '2018-09-20',
      },
    );
    expect(updates).toEqual({
      date_of_birth: '1985-02-28',
    });
  });

  it('ignores undefined fields in legacy data', () => {
    const updates = profilePrefillToUpdate(
      '',
      null,
      null,
      { name: 'Grace' },
    );
    expect(updates).toEqual({ name: 'Grace' });
    expect(updates.date_of_birth).toBeUndefined();
    expect(updates.date_of_anniversary).toBeUndefined();
  });

  it('ignores legacy data when prefill data is empty', () => {
    const updates = profilePrefillToUpdate(
      'Henry',
      '2000-07-10',
      '2020-11-22',
      {},
    );
    expect(updates).toEqual({});
  });
});

describe('profilePrefillToUpdate with no Petpooja row', () => {
  it('returns no updates', () => {
    expect(profilePrefillToUpdate('', null, null, null)).toEqual({});
  });
});

describe('istToday', () => {
  it('is already the next day in India at 20:00 UTC', () => {
    expect(istToday(new Date('2026-09-25T20:00:00Z'))).toBe('2026-09-26');
  });

  it('is the same day in India at 10:00 UTC', () => {
    expect(istToday(new Date('2026-09-25T10:00:00Z'))).toBe('2026-09-25');
  });
});

describe('parseIsoDate', () => {
  const now = new Date('2026-09-25T20:00:00Z'); // 26 Sep in India

  it('returns null for empty input', () => {
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate('   ')).toBeNull();
  });

  it('accepts a real date', () => {
    expect(parseIsoDate('1990-02-28', true, now)).toBe('1990-02-28');
  });

  it('rejects a malformed or impossible date', () => {
    expect(() => parseIsoDate('26/09/2026')).toThrow('YYYY-MM-DD');
    expect(() => parseIsoDate('2026-13-45')).toThrow('Invalid date');
    expect(() => parseIsoDate('2025-02-29')).toThrow('Invalid date');
  });

  it('rejects years before 1900', () => {
    expect(() => parseIsoDate('1899-12-31')).toThrow('1900');
  });

  it("allows a birthday of today in India even when it's still yesterday in UTC", () => {
    expect(parseIsoDate('2026-09-26', true, now)).toBe('2026-09-26');
  });

  it('rejects a birthday after today in India', () => {
    expect(() => parseIsoDate('2026-09-27', true, now)).toThrow('future');
  });

  it('allows a future anniversary', () => {
    expect(parseIsoDate('2030-01-01', false, now)).toBe('2030-01-01');
  });
});

// Minimal stand-in for the admin client: records profile updates and serves
// canned profile / legacy_customers reads.
function fakeAdmin(opts: {
  profile?: { data: unknown; error: unknown };
  legacy?: { data: unknown; error: unknown };
  updateError?: unknown;
  throwOn?: 'legacy_customers';
}) {
  const updates: unknown[] = [];
  const admin = {
    from(table: string) {
      if (opts.throwOn === table) throw new Error('boom');
      const read = table === 'profiles' ? opts.profile : opts.legacy;
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => read ?? { data: null, error: null },
        update: (u: unknown) => {
          updates.push(u);
          return { eq: async () => ({ error: opts.updateError ?? null }) };
        },
      };
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient, updates };
}

describe('prefillProfileFromPetpooja', () => {
  const legacy = { data: { name: 'Asha', date_of_birth: '1995-04-12', date_of_anniversary: null }, error: null };

  it('fills only the blank fields', async () => {
    const { admin, updates } = fakeAdmin({
      profile: { data: { name: 'Asha K', date_of_birth: null, date_of_anniversary: null }, error: null },
      legacy,
    });
    await prefillProfileFromPetpooja(admin, 'u1', '+919876543210');
    expect(updates).toEqual([{ date_of_birth: '1995-04-12' }]);
  });

  it('writes nothing when the profile read fails (never treats the name as blank)', async () => {
    const { admin, updates } = fakeAdmin({
      profile: { data: null, error: { message: 'column does not exist' } },
      legacy,
    });
    await prefillProfileFromPetpooja(admin, 'u1', '+919876543210');
    expect(updates).toEqual([]);
  });

  it('never throws, even when a query throws', async () => {
    const { admin } = fakeAdmin({
      profile: { data: { name: '', date_of_birth: null, date_of_anniversary: null }, error: null },
      throwOn: 'legacy_customers',
    });
    await expect(prefillProfileFromPetpooja(admin, 'u1', '+919876543210')).resolves.toBeUndefined();
  });

  it('swallows an update error', async () => {
    const { admin, updates } = fakeAdmin({
      profile: { data: { name: '', date_of_birth: null, date_of_anniversary: null }, error: null },
      legacy,
      updateError: { message: 'nope' },
    });
    await expect(prefillProfileFromPetpooja(admin, 'u1', '+919876543210')).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
  });
});
