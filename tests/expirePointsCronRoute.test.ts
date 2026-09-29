import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for GET /api/cron/expire-points: fails CLOSED without a
// valid CRON_SECRET bearer token, and otherwise hands the server function's
// counts straight back. The expiry maths itself is in loyaltyExpiry.test.ts.

const { expireLoyaltyPoints } = vi.hoisted(() => ({
  expireLoyaltyPoints: vi.fn(() => Promise.resolve({ users: 0, points: 0 })),
}));

vi.mock('@/lib/loyalty/ledger', () => ({ expireLoyaltyPoints }));

process.env.CRON_SECRET = 'cron_secret';

const { GET } = await import('@/app/api/cron/expire-points/route');

const run = (auth = 'Bearer cron_secret') =>
  GET(new Request('http://localhost/api/cron/expire-points', { headers: auth ? { authorization: auth } : {} }));

beforeEach(() => {
  expireLoyaltyPoints.mockClear();
  expireLoyaltyPoints.mockResolvedValue({ users: 0, points: 0 });
});

describe('GET /api/cron/expire-points — auth', () => {
  it('fails CLOSED with no Authorization header', async () => {
    const res = await run('');
    expect(res.status).toBe(401);
    expect(expireLoyaltyPoints).not.toHaveBeenCalled();
  });

  it('fails CLOSED with a wrong bearer token', async () => {
    const res = await run('Bearer wrong');
    expect(res.status).toBe(401);
    expect(expireLoyaltyPoints).not.toHaveBeenCalled();
  });

  it('fails CLOSED when CRON_SECRET itself is unset', async () => {
    const original = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await run('Bearer cron_secret');
      expect(res.status).toBe(401);
      expect(expireLoyaltyPoints).not.toHaveBeenCalled();
    } finally {
      process.env.CRON_SECRET = original;
    }
  });
});

describe('GET /api/cron/expire-points — run', () => {
  it('calls the server function and returns its counts', async () => {
    expireLoyaltyPoints.mockResolvedValueOnce({ users: 3, points: 125 });
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: 3, points: 125 });
    expect(expireLoyaltyPoints).toHaveBeenCalledTimes(1);
  });
});
