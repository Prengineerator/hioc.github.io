import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/auth/me — the root-cause fix for the owner's bug report: a
// WhatsApp/phone-OTP account (also what guest checkout's OTP creates) has
// NO email, and this route used to respond with just `{ user: { email } }`.
// AccountNav treated `!data.user?.email` as "logged out", so a signed-in
// phone customer saw "Log In" and never saw "My Account". The fix widens
// the shape to `{ id, email, phone, name }` so callers check
// `data.user != null` instead of any one field — this file proves a
// phone-only session comes back as a non-null user with no email at all.

const state: {
  user: { id: string; email?: string | null; phone?: string | null } | null;
  profile: { name: string | null; phone: string | null } | null;
} = { user: null, profile: null };

vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve(state.user),
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.profile, error: null }),
        }),
      }),
    }),
  }),
}));

const { GET } = await import('@/app/api/auth/me/route');

beforeEach(() => {
  state.user = null;
  state.profile = null;
});

describe('GET /api/auth/me', () => {
  it('returns user: null with no session', async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ user: null });
  });

  it('sends Cache-Control: no-store on every response', async () => {
    const anon = await GET();
    expect(anon.headers.get('Cache-Control')).toBe('no-store');

    state.user = { id: 'u1', email: 'a@b.com' };
    state.profile = { name: null, phone: null };
    const signedIn = await GET();
    expect(signedIn.headers.get('Cache-Control')).toBe('no-store');
  });

  it('THE FIX: a phone-only (no email) session comes back as a non-null user', async () => {
    // Exactly the WhatsApp/phone-OTP account from the bug report: Supabase
    // Auth's `user.email` is undefined, but there IS a session.
    state.user = { id: 'u1', email: null, phone: '+919876543210' };
    state.profile = { name: null, phone: '+919876543210' };

    const res = await GET();
    const body = await res.json();

    // The old bug: components/site/AccountNav.tsx checked
    // `!data.user?.email` — which this user would have failed.
    expect(body.user).not.toBeNull();
    expect(body.user.email).toBeNull();
    expect(body.user.id).toBe('u1');
    expect(body.user.phone).toBe('+919876543210');
  });

  it('includes id, email, phone, and name for a full account', async () => {
    state.user = { id: 'u2', email: 'jane@example.com', phone: null };
    state.profile = { name: 'Jane', phone: '+919876500000' };

    const res = await GET();
    expect(await res.json()).toEqual({
      user: { id: 'u2', email: 'jane@example.com', phone: '+919876500000', name: 'Jane' },
    });
  });

  it('falls back to the Supabase Auth phone when the profiles row has none yet', async () => {
    // phone-otp/verify's profile update is best-effort and can lag a beat
    // behind the session itself — the auth user's own `phone` is already
    // authoritative the moment the session exists.
    state.user = { id: 'u3', email: null, phone: '+919876511111' };
    state.profile = { name: null, phone: '' };

    const res = await GET();
    const body = await res.json();
    expect(body.user.phone).toBe('+919876511111');
  });

  it('falls back to the Supabase Auth phone when there is no profile row at all', async () => {
    state.user = { id: 'u4', email: null, phone: '+919876522222' };
    state.profile = null;

    const res = await GET();
    const body = await res.json();
    expect(body.user).toEqual({ id: 'u4', email: null, phone: '+919876522222', name: null });
  });

  it('name/email/phone are all null when nothing is on file', async () => {
    state.user = { id: 'u5' };
    state.profile = { name: '', phone: '' };

    const res = await GET();
    expect(await res.json()).toEqual({
      user: { id: 'u5', email: null, phone: null, name: null },
    });
  });
});
