import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// Inbound-message handling on POST /api/webhooks/whatsapp — the post-order
// feedback widening of the WA-4 delivery-status webhook.
//
// What these hold, in the order they matter:
//   1. The bad-signature / fail-closed path from tests/whatsappWebhook.test.ts
//      is untouched by this widening — re-asserted here as a smoke test, not
//      re-derived in full (that file owns the exhaustive signature coverage).
//   2. A button tap sets the request's rating AND sends the matching
//      follow-up (Google review link for 5, "what could we do better" for
//      3/1) — never both, never neither.
//   3. STOP/UNSUBSCRIBE (case-insensitive) opts the phone out and sends
//      exactly one confirmation.
//   4. Plain text is stored, linked to the customer's most recent request.
//   5. A duplicate wa_message_id is applied exactly once — no double rating
//      update, no double follow-up.

const APP_SECRET = 'app-secret-for-tests';

interface FeedbackRequestRow {
  id: string;
  order_id: string;
  phone: string;
  customer_name: string;
  rating: number | null;
  rating_source: string | null;
  responded_at: string | null;
  unread: boolean;
  last_inbound_at: string | null;
  created_at: string;
}

interface FeedbackMessageRow {
  id: string;
  request_id: string | null;
  order_id: string | null;
  phone: string;
  direction: 'in' | 'out';
  body: string;
  button_payload: string;
  wa_message_id: string | null;
  status: string;
}

const db: {
  requests: FeedbackRequestRow[];
  messages: FeedbackMessageRow[];
  optOuts: { phone: string; source: string }[];
  nextMsgId: number;
} = { requests: [], messages: [], optOuts: [], nextMsgId: 1 };

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@/lib/notifications/adapters', () => ({
  whatsappAdapter: { send: sendMock },
}));

vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () =>
    Promise.resolve({ feedback_enabled: true, feedback_delay_min: 30, google_review_url: 'https://g.page/r/test/review' }),
}));

// Minimal PostgREST stand-in covering exactly what applyInboundMessage /
// resolveFeedbackRequest / processInboundMessages need: select+eq(+order+limit)
// +maybeSingle reads, insert, update, and upsert (for whatsapp_opt_outs).
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const filters: { col: string; val: unknown }[] = [];
      let order: { col: string; asc: boolean } | null = null;
      let limitN = Infinity;
      const chain: Record<string, unknown> = {};

      const rowsOf = (): Record<string, unknown>[] =>
        table === 'feedback_requests'
          ? (db.requests as unknown as Record<string, unknown>[])
          : table === 'feedback_messages'
            ? (db.messages as unknown as Record<string, unknown>[])
            : [];

      const matched = () => {
        let rows = rowsOf().filter((r) => filters.every((f) => r[f.col] === f.val));
        if (order) {
          rows = [...rows].sort((a, b) => {
            const av = String(a[order!.col]);
            const bv = String(b[order!.col]);
            return order!.asc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        return rows.slice(0, limitN);
      };

      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push({ col, val });
          return chain;
        },
        order: (col: string, opts: { ascending?: boolean } = {}) => {
          order = { col, asc: opts.ascending !== false };
          return chain;
        },
        limit: (n: number) => {
          limitN = n;
          return chain;
        },
        maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
        insert: (row: Record<string, unknown>) => {
          if (table === 'feedback_messages') {
            if (row.wa_message_id && db.messages.some((m) => m.wa_message_id === row.wa_message_id)) {
              return Promise.resolve({ error: { code: '23505', message: 'duplicate' } });
            }
            db.messages.push({
              id: `m${db.nextMsgId++}`,
              request_id: (row.request_id as string) ?? null,
              order_id: (row.order_id as string) ?? null,
              phone: row.phone as string,
              direction: row.direction as 'in' | 'out',
              body: (row.body as string) ?? '',
              button_payload: (row.button_payload as string) ?? '',
              wa_message_id: (row.wa_message_id as string) ?? null,
              status: (row.status as string) ?? '',
            });
            return Promise.resolve({ error: null });
          }
          return Promise.resolve({ error: null });
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, val: unknown) => {
            if (table === 'feedback_requests') {
              const row = db.requests.find((r) => r[col as keyof FeedbackRequestRow] === val);
              if (row) Object.assign(row, patch);
            }
            return Promise.resolve({ error: null });
          },
        }),
        upsert: (row: Record<string, unknown>) => {
          if (table === 'whatsapp_opt_outs') {
            const existing = db.optOuts.find((o) => o.phone === row.phone);
            if (existing) Object.assign(existing, row);
            else db.optOuts.push({ phone: row.phone as string, source: (row.source as string) ?? '' });
          }
          return Promise.resolve({ error: null });
        },
      });
      return chain;
    },
  }),
}));

const { GET, POST } = await import('@/app/api/webhooks/whatsapp/route');

function inboundBody(messages: Record<string, unknown>[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '911', phone_number_id: '111222' },
              messages,
            },
          },
        ],
      },
    ],
  };
}

function post(body: unknown) {
  const raw = JSON.stringify(body);
  const digest = createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex');
  return new Request('http://t/api/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${digest}` },
    body: raw,
  });
}

function seedRequest(over: Partial<FeedbackRequestRow> = {}): FeedbackRequestRow {
  const row: FeedbackRequestRow = {
    id: 'req-1',
    order_id: 'order-1',
    phone: '+919876543210',
    customer_name: 'Priya',
    rating: null,
    rating_source: null,
    responded_at: null,
    unread: false,
    last_inbound_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
  db.requests.push(row);
  return row;
}

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  db.requests = [];
  db.messages = [];
  db.optOuts = [];
  db.nextMsgId = 1;
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ok: true, providerRef: 'wamid.FOLLOWUP', error: '' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('POST /api/webhooks/whatsapp — inbound: signature unchanged', () => {
  it('still 401s an unsigned inbound message body', async () => {
    const req = new Request('http://t/api/webhooks/whatsapp', {
      method: 'POST',
      body: JSON.stringify(inboundBody([{ id: 'wamid.1', from: '919876543210', type: 'text', text: { body: 'hi' } }])),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(db.messages).toEqual([]);
  });

  it('GET handshake is untouched', async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
    const res = await GET(
      new Request('http://t/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42'),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('42');
  });
});

describe('POST /api/webhooks/whatsapp — button taps', () => {
  it('a Loved-it tap sets rating 5 and sends the Google review follow-up', async () => {
    const request = seedRequest();
    const res = await POST(
      post(
        inboundBody([
          { id: 'wamid.btn1', from: '919876543210', type: 'button', button: { payload: `fb:${request.id}:5`, text: '😍 Loved it' } },
        ]),
      ),
    );
    expect(res.status).toBe(200);
    expect(request.rating).toBe(5);
    expect(request.rating_source).toBe('whatsapp_button');
    expect(request.responded_at).not.toBeNull();

    // The button tap itself is recorded, AND exactly one follow-up went out.
    const inbound = db.messages.find((m) => m.direction === 'in');
    expect(inbound?.button_payload).toBe(`fb:${request.id}:5`);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [sendArgs] = sendMock.mock.calls[0];
    expect(sendArgs.body).toContain('g.page/r/test/review');
    const outbound = db.messages.find((m) => m.direction === 'out');
    expect(outbound?.body).toContain('g.page/r/test/review');
  });

  it('an "It was okay" tap (rating 3) sends the "what could we do better" follow-up, not the review link', async () => {
    const request = seedRequest();
    await POST(
      post(
        inboundBody([
          { id: 'wamid.btn2', from: '919876543210', type: 'button', button: { payload: `fb:${request.id}:3`, text: '🙂 It was okay' } },
        ]),
      ),
    );
    expect(request.rating).toBe(3);
    const outbound = db.messages.find((m) => m.direction === 'out');
    expect(outbound?.body).toMatch(/what could we do better/i);
    expect(outbound?.body).not.toContain('g.page');
  });

  it('a Not-happy tap (rating 1) also sends the "what could we do better" follow-up', async () => {
    const request = seedRequest();
    await POST(
      post(
        inboundBody([
          { id: 'wamid.btn3', from: '919876543210', type: 'button', button: { payload: `fb:${request.id}:1`, text: '😞 Not happy' } },
        ]),
      ),
    );
    expect(request.rating).toBe(1);
    const outbound = db.messages.find((m) => m.direction === 'out');
    expect(outbound?.body).toMatch(/what could we do better/i);
  });

  it('falls back to the button TEXT when the payload is missing', async () => {
    const request = seedRequest();
    await POST(
      post(inboundBody([{ id: 'wamid.btn4', from: '919876543210', type: 'button', button: { payload: '', text: '😍 Loved it' } }])),
    );
    expect(request.rating).toBe(5);
  });

  it('never trusts a payload naming a request that belongs to a DIFFERENT phone', async () => {
    const mine = seedRequest({ id: 'req-mine', phone: '+919876543210' });
    const someoneElses = seedRequest({ id: 'req-theirs', phone: '+919999999999', rating: null });
    // The inbound sender is req-mine's phone, but the payload names req-theirs.
    await POST(
      post(
        inboundBody([
          { id: 'wamid.spoof', from: '919876543210', type: 'button', button: { payload: `fb:${someoneElses.id}:5`, text: '' } },
        ]),
      ),
    );
    expect(someoneElses.rating).toBeNull(); // untouched
    // Falls back to resolving by phone — the caller's own most recent request.
    expect(mine.rating).toBe(5);
  });
});

describe('POST /api/webhooks/whatsapp — STOP / opt-out', () => {
  it('STOP (any case) records an opt-out and sends exactly one confirmation', async () => {
    seedRequest();
    const res = await POST(post(inboundBody([{ id: 'wamid.stop1', from: '919876543210', type: 'text', text: { body: 'stop' } }])));
    expect(res.status).toBe(200);
    expect(db.optOuts).toEqual([{ phone: '+919876543210', source: 'stop_keyword' }]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(db.messages.filter((m) => m.direction === 'out')).toHaveLength(1);
  });

  it('UNSUBSCRIBE also opts out', async () => {
    seedRequest();
    await POST(post(inboundBody([{ id: 'wamid.stop2', from: '919876543210', type: 'text', text: { body: 'UNSUBSCRIBE' } }])));
    expect(db.optOuts).toHaveLength(1);
  });

  it('does not opt out on ordinary text that merely mentions stopping', async () => {
    seedRequest();
    await POST(post(inboundBody([{ id: 'wamid.notstop', from: '919876543210', type: 'text', text: { body: 'please stop calling me at odd hours' } }])));
    expect(db.optOuts).toEqual([]);
  });
});

describe('POST /api/webhooks/whatsapp — plain text is stored', () => {
  it('links a typed reply to the customer\'s most recent feedback request', async () => {
    const request = seedRequest();
    const res = await POST(
      post(inboundBody([{ id: 'wamid.txt1', from: '919876543210', type: 'text', text: { body: 'The coffee was cold' } }])),
    );
    expect(res.status).toBe(200);
    const stored = db.messages.find((m) => m.direction === 'in');
    expect(stored?.body).toBe('The coffee was cold');
    expect(stored?.request_id).toBe(request.id);
    expect(request.unread).toBe(true);
    // Plain text with no rating resolved sends no automated follow-up.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a phone with no feedback request at all still gets its text stored (phone-only thread)', async () => {
    const res = await POST(
      post(inboundBody([{ id: 'wamid.txt2', from: '911111111111', type: 'text', text: { body: 'hello?' } }])),
    );
    expect(res.status).toBe(200);
    const stored = db.messages.find((m) => m.direction === 'in');
    expect(stored?.request_id).toBeNull();
    expect(stored?.phone).toBe('+911111111111');
  });
});

describe('POST /api/webhooks/whatsapp — duplicate wamid dedup', () => {
  it('applies a repeated inbound message exactly once', async () => {
    const request = seedRequest();
    const msg = { id: 'wamid.dup', from: '919876543210', type: 'button', button: { payload: `fb:${request.id}:5`, text: '' } };
    await POST(post(inboundBody([msg])));
    await POST(post(inboundBody([msg]))); // Meta retry of the SAME delivery

    expect(db.messages.filter((m) => m.wa_message_id === 'wamid.dup')).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(1); // no second follow-up
    const body = await POST(post(inboundBody([msg]))).then((r) => r.json());
    expect(body.messages).toMatchObject({ applied: 0, duplicate: 1 });
  });

  it('a duplicate among an otherwise-new batch only skips the repeat', async () => {
    seedRequest();
    await POST(
      post(inboundBody([{ id: 'wamid.first', from: '919876543210', type: 'text', text: { body: 'first' } }])),
    );
    const res = await POST(
      post(
        inboundBody([
          { id: 'wamid.first', from: '919876543210', type: 'text', text: { body: 'first' } }, // repeat
          { id: 'wamid.second', from: '919876543210', type: 'text', text: { body: 'second' } }, // new
        ]),
      ),
    );
    const body = await res.json();
    expect(body.messages).toMatchObject({ applied: 1, duplicate: 1 });
    expect(db.messages.map((m) => m.body)).toEqual(expect.arrayContaining(['first', 'second']));
  });
});
