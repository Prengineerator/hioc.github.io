import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashFeedbackToken } from '@/lib/feedback/token';

// GET/POST /api/feedback/[token] — the public, token-gated web feedback page's
// API. What these hold:
//   1. Token validation: an unknown token 404s, a token past the 7-day edit
//      window 410s, and NEITHER leaks anything about the underlying request.
//   2. A submitted rating is stored on feedback_requests (rating_source
//      'web_form') AND written into the existing `reviews` table — overall
//      AND per-item (thumbs), never trusting a menu_item_id the order doesn't
//      actually contain.
//   3. Editing within the window updates the SAME review row rather than
//      creating a second one.
//   4. Rate-limited.

interface Row extends Record<string, unknown> {
  id: string;
}

const db: {
  feedback_requests: Row[];
  orders: Row[];
  order_items: Row[];
  reviews: Row[];
  feedback_messages: Row[];
} = { feedback_requests: [], orders: [], order_items: [], reviews: [], feedback_messages: [] };

let nextId = 1;

vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: () => Promise.resolve(true),
  clientIp: () => '127.0.0.1',
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: keyof typeof db) => {
      const filters: { col: string; val: unknown; isNull?: boolean }[] = [];
      const rows = () => db[table] ?? [];
      const matched = () =>
        rows().filter((r) =>
          filters.every((f) => (f.isNull ? (r[f.col] ?? null) === null : r[f.col] === f.val)),
        );

      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push({ col, val });
          return chain;
        },
        is: (col: string) => {
          filters.push({ col, val: null, isNull: true });
          return chain;
        },
        maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
        insert: (row: Record<string, unknown>) => {
          const withId = { id: `${table}-${nextId++}`, ...row } as Row;
          (db[table] as Row[]).push(withId);
          return Promise.resolve({ error: null });
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, val: unknown) => {
            const target = rows().find((r) => r[col] === val);
            if (target) Object.assign(target, patch);
            return Promise.resolve({ error: null });
          },
        }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: matched(), error: null }).then(resolve),
      });
      return chain;
    },
  }),
}));

const { GET, POST } = await import('@/app/api/feedback/[token]/route');

const TOKEN = 'a-valid-looking-token-1234567890abcdef';
const HASH = hashFeedbackToken(TOKEN);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function seed() {
  db.feedback_requests = [
    {
      id: 'req-1',
      order_id: 'order-1',
      phone: '+919876543210',
      customer_name: 'Priya',
      token_hash: HASH,
      rating: null,
      rating_source: null,
      responded_at: null,
      unread: false,
      created_at: daysAgo(1),
    },
  ];
  const items = [
    { id: 'oi-1', order_id: 'order-1', menu_item_id: 'mi-1', name_snapshot: 'Cold Brew', quantity: 1, voided: false },
    { id: 'oi-2', order_id: 'order-1', menu_item_id: 'mi-2', name_snapshot: 'Waffle', quantity: 2, voided: false },
  ];
  // The route's GET reads items via a nested `order_items(...)` embed on the
  // `orders` select, which this mock does not really join — so the orders row
  // carries the embed pre-shaped, exactly as PostgREST would return it.
  db.orders = [{ id: 'order-1', order_number: 1089, order_items: items }];
  db.order_items = items;
  db.reviews = [];
  db.feedback_messages = [];
}

beforeEach(() => {
  nextId = 1;
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const params = { params: { token: TOKEN } };
const bogusParams = { params: { token: 'this-token-does-not-exist-anywhere-00000000' } };

function postBody(body: unknown) {
  return new Request('http://t/api/feedback/x', { method: 'POST', body: JSON.stringify(body) });
}

describe('GET /api/feedback/[token] — token validation', () => {
  it('returns the order summary for a valid token', async () => {
    const res = await GET(new Request('http://t'), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.order.order_number).toBe('HIOC-001089');
    expect(body.order.items).toHaveLength(2);
  });

  it('404s an unknown token, without revealing whether ANY request exists', async () => {
    const res = await GET(new Request('http://t'), bogusParams);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('not_found');
  });

  it('rejects an obviously-malformed token before it ever reaches the database', async () => {
    const res = await GET(new Request('http://t'), { params: { token: 'x' } });
    expect(res.status).toBe(404);
  });

  it('410s a token past the 7-day edit window', async () => {
    db.feedback_requests[0].created_at = daysAgo(8);
    const res = await GET(new Request('http://t'), params);
    expect(res.status).toBe(410);
    expect((await res.json()).reason).toBe('expired');
  });

  it('is still valid at 6 days old', async () => {
    db.feedback_requests[0].created_at = daysAgo(6);
    const res = await GET(new Request('http://t'), params);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/feedback/[token] — submitting feedback', () => {
  it('rejects a missing/invalid rating', async () => {
    const res = await POST(postBody({ rating: 0 }), params);
    expect(res.status).toBe(400);
  });

  it('rejects submission against an unknown token', async () => {
    const res = await POST(postBody({ rating: 5 }), bogusParams);
    expect(res.status).toBe(404);
  });

  it('rejects submission past the edit window', async () => {
    db.feedback_requests[0].created_at = daysAgo(10);
    const res = await POST(postBody({ rating: 5 }), params);
    expect(res.status).toBe(410);
  });

  it('stores the rating on the request as web_form, and writes an overall review row', async () => {
    const res = await POST(postBody({ rating: 4, comment: 'Great coffee!' }), params);
    expect(res.status).toBe(200);

    expect(db.feedback_requests[0].rating).toBe(4);
    expect(db.feedback_requests[0].rating_source).toBe('web_form');
    expect(db.feedback_requests[0].responded_at).not.toBeNull();
    expect(db.feedback_requests[0].unread).toBe(true);

    const overall = db.reviews.find((r) => r.order_id === 'order-1' && r.menu_item_id === null);
    expect(overall).toBeTruthy();
    expect(overall?.rating).toBe(4);
    expect(overall?.comment).toBe('Great coffee!');
  });

  it('writes a per-item review row for each valid thumb, mapped to 5/1', async () => {
    await POST(postBody({ rating: 5, itemThumbs: { 'mi-1': 'up', 'mi-2': 'down' } }), params);

    const up = db.reviews.find((r) => r.menu_item_id === 'mi-1');
    const down = db.reviews.find((r) => r.menu_item_id === 'mi-2');
    expect(up?.rating).toBe(5);
    expect(down?.rating).toBe(1);
  });

  it('ignores a thumb for a menu_item_id that is not actually on this order', async () => {
    await POST(postBody({ rating: 5, itemThumbs: { 'mi-999-not-on-order': 'up' } }), params);
    expect(db.reviews.find((r) => r.menu_item_id === 'mi-999-not-on-order')).toBeUndefined();
  });

  it('appends a non-empty comment to the feedback thread', async () => {
    await POST(postBody({ rating: 5, comment: 'Loved the waffle' }), params);
    const msg = db.feedback_messages.find((m) => m.direction === 'in');
    expect(msg?.body).toBe('Loved the waffle');
    expect(msg?.request_id).toBe('req-1');
  });

  it('does not append a message when the comment is empty', async () => {
    await POST(postBody({ rating: 5 }), params);
    expect(db.feedback_messages).toEqual([]);
  });

  it('editing (re-submitting within the window) updates the SAME overall review row, not a second one', async () => {
    await POST(postBody({ rating: 3, comment: 'meh' }), params);
    await POST(postBody({ rating: 5, comment: 'actually great' }), params);

    const overallRows = db.reviews.filter((r) => r.order_id === 'order-1' && r.menu_item_id === null);
    expect(overallRows).toHaveLength(1);
    expect(overallRows[0].rating).toBe(5);
    expect(overallRows[0].comment).toBe('actually great');
    expect(db.feedback_requests[0].rating).toBe(5);
  });
});
