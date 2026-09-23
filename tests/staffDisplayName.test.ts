import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { nameFromEmail, staffDisplayName, getStaffDisplayNames } from '@/lib/staff/displayName';

// Staff accounts are created as <name>@hioc.in and profiles.name is usually
// never set, which is why the attendance sheet, payroll and the leave team
// view all used to show "(no name)". This file pins the fallback chain
// (profiles.name → title-cased email local part → fallback) so it can't
// regress silently on any one of those surfaces.

describe('nameFromEmail', () => {
  it('title-cases a dot-separated local part', () => {
    expect(nameFromEmail('ravi.kumar@hioc.in')).toBe('Ravi Kumar');
  });

  it('splits on underscores', () => {
    expect(nameFromEmail('ravi_kumar@hioc.in')).toBe('Ravi Kumar');
  });

  it('splits on hyphens', () => {
    expect(nameFromEmail('ravi-kumar@hioc.in')).toBe('Ravi Kumar');
  });

  it('treats plus-addressing as a separator, not part of the name', () => {
    expect(nameFromEmail('ravi+kitchen@hioc.in')).toBe('Ravi Kitchen');
  });

  it('normalizes an all-caps or all-lowercase local part the same way', () => {
    expect(nameFromEmail('RAVI.KUMAR@HIOC.IN')).toBe('Ravi Kumar');
    expect(nameFromEmail('ravi.kumar@hioc.in')).toBe('Ravi Kumar');
  });

  it('collapses runs of separators instead of producing blank words', () => {
    expect(nameFromEmail('ravi..kumar@hioc.in')).toBe('Ravi Kumar');
    expect(nameFromEmail('ravi._-+kumar@hioc.in')).toBe('Ravi Kumar');
  });

  it('handles a single-word local part', () => {
    expect(nameFromEmail('priya@hioc.in')).toBe('Priya');
  });

  it('returns empty for a missing or empty email', () => {
    expect(nameFromEmail(null)).toBe('');
    expect(nameFromEmail(undefined)).toBe('');
    expect(nameFromEmail('')).toBe('');
  });

  it('returns empty when the local part is only whitespace or separators', () => {
    expect(nameFromEmail(' @hioc.in')).toBe('');
    expect(nameFromEmail('...@hioc.in')).toBe('');
  });
});

describe('staffDisplayName', () => {
  it('prefers a non-empty profile name, trimmed, over the email', () => {
    expect(staffDisplayName('  Priya Sharma  ', 'priya@hioc.in')).toBe('Priya Sharma');
  });

  it('falls back to the email-derived name when the profile name is empty or whitespace', () => {
    expect(staffDisplayName('', 'ravi.kumar@hioc.in')).toBe('Ravi Kumar');
    expect(staffDisplayName('   ', 'ravi.kumar@hioc.in')).toBe('Ravi Kumar');
    expect(staffDisplayName(null, 'ravi.kumar@hioc.in')).toBe('Ravi Kumar');
    expect(staffDisplayName(undefined, 'ravi.kumar@hioc.in')).toBe('Ravi Kumar');
  });

  it('falls back to "Unknown staff" when both name and email are missing', () => {
    expect(staffDisplayName(null, null)).toBe('Unknown staff');
    expect(staffDisplayName('', '')).toBe('Unknown staff');
  });

  it('honors a caller-supplied fallback', () => {
    expect(staffDisplayName(null, null, 'Staff member')).toBe('Staff member');
  });
});

// A minimal stand-in for the pieces of SupabaseClient getStaffDisplayNames
// actually calls: profiles.select().in(), and auth.admin.listUsers() for the
// ids that lookup leaves unnamed. Built directly (no vi.mock) since the
// function takes its client as a parameter rather than importing one.
function fakeAdmin(opts: {
  profiles: { id: string; name: string | null }[];
  authUsers?: { id: string; email: string | null }[];
  profilesError?: unknown;
}): SupabaseClient {
  const listUsersCalls: unknown[] = [];
  return {
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          in: () =>
            Promise.resolve(
              opts.profilesError
                ? { data: null, error: opts.profilesError }
                : { data: opts.profiles, error: null },
            ),
        }),
      };
    },
    auth: {
      admin: {
        listUsers: (args: { page: number; perPage: number }) => {
          listUsersCalls.push(args);
          // Single page is enough for these tests — every scenario here has
          // well under 1000 unnamed ids.
          if (args.page > 1) return Promise.resolve({ data: { users: [] }, error: null });
          return Promise.resolve({ data: { users: opts.authUsers ?? [] }, error: null });
        },
      },
    },
  } as unknown as SupabaseClient;
}

describe('getStaffDisplayNames', () => {
  it('returns an empty map without touching the client for an empty id list', async () => {
    let called = false;
    const admin = {
      from: () => {
        called = true;
        throw new Error('should not be called');
      },
    } as unknown as SupabaseClient;
    const out = await getStaffDisplayNames(admin, []);
    expect(out.size).toBe(0);
    expect(called).toBe(false);
  });

  it('dedupes ids and uses profiles.name when it is set', async () => {
    const admin = fakeAdmin({ profiles: [{ id: 'u1', name: 'Priya Sharma' }] });
    const out = await getStaffDisplayNames(admin, ['u1', 'u1', 'u1']);
    expect(out.get('u1')).toBe('Priya Sharma');
  });

  it('falls back to the email-derived name for ids with no profile name', async () => {
    const admin = fakeAdmin({
      profiles: [
        { id: 'u1', name: 'Priya Sharma' },
        { id: 'u2', name: null },
        { id: 'u3', name: '  ' },
      ],
      authUsers: [
        { id: 'u2', email: 'ravi.kumar@hioc.in' },
        { id: 'u3', email: 'meera_iyer@hioc.in' },
      ],
    });
    const out = await getStaffDisplayNames(admin, ['u1', 'u2', 'u3']);
    expect(out.get('u1')).toBe('Priya Sharma');
    expect(out.get('u2')).toBe('Ravi Kumar');
    expect(out.get('u3')).toBe('Meera Iyer');
  });

  it('falls back to "Unknown staff" for an id missing from both profiles and auth', async () => {
    const admin = fakeAdmin({ profiles: [], authUsers: [] });
    const out = await getStaffDisplayNames(admin, ['ghost']);
    expect(out.get('ghost')).toBe('Unknown staff');
  });

  it('honors a caller-supplied fallback for an unresolved id', async () => {
    const admin = fakeAdmin({ profiles: [], authUsers: [] });
    const out = await getStaffDisplayNames(admin, ['ghost'], 'Staff member');
    expect(out.get('ghost')).toBe('Staff member');
  });

  it('degrades to resolved-so-far rather than throwing when the profiles lookup errors', async () => {
    const admin = fakeAdmin({ profiles: [], profilesError: { message: 'boom' }, authUsers: [] });
    const out = await getStaffDisplayNames(admin, ['u1']);
    expect(out.get('u1')).toBe('Unknown staff');
  });
});
