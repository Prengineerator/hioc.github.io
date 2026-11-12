import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import { LOCKOUT_THRESHOLD } from '@/lib/staff/pinPolicy';

// verifyPin (lib/staff/pinAuth.ts) against an in-memory staff_pins row, with
// bcrypt replaced by a compare the test can hold open — the window in which
// parallel guesses used to read the same failed_attempts and each write "+1"
// over it. Every write is now a compare-and-set on failed_attempts, so no
// wrong guess is lost, and a correct PIN that was still in bcrypt when racing
// guesses reached the lock does not reset that lock.

const USER = '11111111-1111-4111-8111-111111111111';
const GOOD = '4826';

let admin: SupabaseClient;
let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => admin,
}));

// A compare waits on the gate held for its PIN ('*' = every PIN) so the test
// decides when bcrypt "finishes", and in which order.
const gates = new Map<string, Promise<void>>();
/** Runs inside bcrypt — after the row was read, before the guess is written. */
let duringCompare: (() => void) | null = null;
vi.mock('bcryptjs', () => ({
  default: {
    compare: async (pin: string) => {
      duringCompare?.();
      const gate = gates.get(pin) ?? gates.get('*');
      if (gate) await gate;
      return pin === GOOD;
    },
    hash: async (pin: string) => `hash:${pin}`,
  },
}));

const { verifyPin } = await import('@/lib/staff/pinAuth');

function pinRow(): Row {
  return tables.staff_pins[0];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'));
  gates.clear();
  duringCompare = null;
  tables = {
    staff_pins: [
      {
        user_id: USER,
        pin_hash: `hash:${GOOD}`,
        failed_attempts: 0,
        locked_until: null,
        set_by: 'owner-1',
        updated_at: '2026-11-01T00:00:00.000Z',
      },
    ],
  };
  admin = makeFakeAdmin(tables, { startMs: Date.parse('2026-11-12T10:00:00.000Z') }) as unknown as SupabaseClient;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Holds every compare of `pin` ('*' = any) started from now until release() is called. */
function holdBcrypt(pin = '*'): () => void {
  let release!: () => void;
  gates.set(
    pin,
    new Promise<void>((r) => {
      release = r;
    }),
  );
  return () => {
    gates.delete(pin);
    release();
  };
}

describe('verifyPin — the lockout counter', () => {
  it('a correct PIN works and resets the counter; a wrong one counts', async () => {
    expect(await verifyPin(USER, '0000')).toMatchObject({ ok: false, reason: 'wrong_pin' });
    expect(pinRow().failed_attempts).toBe(1);
    expect(await verifyPin(USER, GOOD)).toEqual({ ok: true });
    expect(pinRow()).toMatchObject({ failed_attempts: 0, locked_until: null });
  });

  it('parallel wrong guesses each count — none is lost — until they reach the lock', async () => {
    const release = holdBcrypt();
    const guesses = Array.from({ length: LOCKOUT_THRESHOLD + 3 }, (_, i) => verifyPin(USER, String(1000 + i)));
    release();
    const results = await Promise.all(guesses);
    expect(results.every((r) => !r.ok && r.reason === 'wrong_pin')).toBe(true);
    // Before: every guess read 0 and wrote 1, so a burst never locked.
    expect(pinRow().failed_attempts).toBe(LOCKOUT_THRESHOLD);
    expect(pinRow().locked_until).not.toBeNull();
    // The ones that found the lock on their retry were refused inside it, as
    // a guess typed during a lock is: told how long, not counted.
    const last = results[results.length - 1] as { retryAfterSeconds: number };
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
    // Locked: even the right PIN is refused now, without being compared.
    expect(await verifyPin(USER, GOOD)).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('a correct PIN racing wrong guesses does not reset a lock they reached', async () => {
    const releaseGood = holdBcrypt(GOOD);
    const correct = verifyPin(USER, GOOD); // read the row (unlocked), now in bcrypt
    const wrong = await Promise.all(Array.from({ length: LOCKOUT_THRESHOLD }, (_, i) => verifyPin(USER, String(2000 + i))));
    expect(wrong.every((r) => !r.ok)).toBe(true);
    expect(pinRow().locked_until).not.toBeNull(); // the guesses locked it
    releaseGood();
    // Before: the correct PIN wrote 0 / no lock over it and got in.
    expect(await correct).toMatchObject({ ok: false, reason: 'locked' });
    expect(pinRow().failed_attempts).toBe(LOCKOUT_THRESHOLD);
    expect(pinRow().locked_until).not.toBeNull();
  });

  it('a correct PIN racing fewer guesses than the lock still gets in, and resets the count', async () => {
    const releaseGood = holdBcrypt(GOOD);
    const correct = verifyPin(USER, GOOD);
    await Promise.all([verifyPin(USER, '1111'), verifyPin(USER, '2222')]);
    expect(pinRow().failed_attempts).toBe(2);
    releaseGood();
    expect(await correct).toEqual({ ok: true });
    // Its reset lost the first race (the count moved), re-read it, and won.
    expect(pinRow()).toMatchObject({ failed_attempts: 0, locked_until: null });
  });

  it('an owner unlock landing mid-guess is not overwritten with the stale count', async () => {
    pinRow().failed_attempts = 4;
    // The guess read 4; the owner unlocks while it is in bcrypt.
    duringCompare = () => {
      pinRow().failed_attempts = 0;
      pinRow().locked_until = null;
    };
    const wrong = verifyPin(USER, '9999');
    expect(await wrong).toMatchObject({ ok: false, reason: 'wrong_pin', retryAfterSeconds: 0 });
    // 0 + 1, not the stale 4 + 1 = 5 that would have locked it again.
    expect(pinRow()).toMatchObject({ failed_attempts: 1, locked_until: null });
  });
});
