import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// WA-4 — the delivery-status webhook.
//
// What these hold, in the order they matter:
//   1. It fails CLOSED. No WHATSAPP_APP_SECRET means no writes, ever — an
//      unsigned webhook is an open write endpoint into the delivery log.
//   2. A forged body is 401 and touches nothing.
//   3. Statuses only move FORWARD. Meta does not guarantee the callbacks arrive
//      in event order, so a late 'delivered' must not un-read a read row.
//   4. Everything else answers 200. Meta retries on any non-2xx, so an unknown
//      message id, a garbage body, and a DB error are all "200, logged".

const APP_SECRET = 'app-secret-for-tests';
const VERIFY_TOKEN = 'verify-token-for-tests';

interface Row {
  id: string;
  provider_ref: string;
  status: string;
  error: string;
  delivered_at: string | null;
  read_at: string | null;
}

const db: { rows: Row[]; failNextUpdate: boolean } = { rows: [], failNextUpdate: false };

// Minimal PostgREST stand-in: enough of the builder for update/select with
// eq/in/is/limit filters, executing once on await (or on maybeSingle).
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const filters: ((row: Row) => boolean)[] = [];
      let op: 'select' | 'update' = 'select';
      let patch: Record<string, unknown> = {};
      let cap = Infinity;

      const run = () => {
        if (op === 'update' && db.failNextUpdate) {
          db.failNextUpdate = false;
          return { data: null, error: { message: 'boom' } };
        }
        const matched = db.rows.filter((r) => filters.every((f) => f(r))).slice(0, cap);
        if (op === 'update') for (const row of matched) Object.assign(row, patch);
        return { data: matched, error: null };
      };

      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          op = 'update';
          patch = p;
          return chain;
        },
        eq: (col: keyof Row, val: unknown) => {
          filters.push((r) => r[col] === val);
          return chain;
        },
        in: (col: keyof Row, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return chain;
        },
        is: (col: keyof Row, val: null) => {
          filters.push((r) => (r[col] ?? null) === val);
          return chain;
        },
        limit: (n: number) => {
          cap = n;
          return chain;
        },
        maybeSingle: () => {
          const res = run();
          return Promise.resolve({ data: (res.data ?? [])[0] ?? null, error: res.error });
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      });
      return chain;
    },
  }),
}));

const { GET, POST } = await import('@/app/api/webhooks/whatsapp/route');

// --- payload helpers -------------------------------------------------------

function statusBody(
  entries: { ref: string; status: string; timestamp?: string; errors?: unknown[] }[],
) {
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
              statuses: entries.map((e) => ({
                id: e.ref,
                status: e.status,
                timestamp: e.timestamp ?? '1754500000',
                recipient_id: '919876543210',
                ...(e.errors ? { errors: e.errors } : {}),
              })),
            },
          },
        ],
      },
    ],
  };
}

function post(body: unknown, opts: { sign?: boolean; badSig?: boolean; rawBody?: string } = {}) {
  const raw = opts.rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign !== false) {
    const digest = createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex');
    headers['x-hub-signature-256'] = opts.badSig ? `sha256=${'0'.repeat(64)}` : `sha256=${digest}`;
  }
  return new Request('http://t/api/webhooks/whatsapp', { method: 'POST', headers, body: raw });
}

const seed = (over: Partial<Row> = {}): Row => {
  const row: Row = {
    id: 'n1',
    provider_ref: 'wamid.HBgMOTE5ABCDEF1234567890',
    status: 'sent',
    error: '',
    delivered_at: null,
    read_at: null,
    ...over,
  };
  db.rows.push(row);
  return row;
};

const REF = 'wamid.HBgMOTE5ABCDEF1234567890';

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  db.rows = [];
  db.failNextUpdate = false;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET — the subscription handshake
// ---------------------------------------------------------------------------

describe('GET /api/webhooks/whatsapp (Meta handshake)', () => {
  const handshake = (params: Record<string, string>) =>
    new Request(`http://t/api/webhooks/whatsapp?${new URLSearchParams(params).toString()}`);

  it('echoes hub.challenge when the verify token matches', async () => {
    const res = await GET(
      handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' }),
    );
    expect(res.status).toBe(200);
    // Meta compares the raw body, so it must not be JSON-wrapped.
    expect(await res.text()).toBe('1158201444');
  });

  it('403s on a wrong verify token', async () => {
    const res = await GET(
      handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1158201444' }),
    );
    expect(res.status).toBe(403);
  });

  it('fails CLOSED with no verify token configured — never echoes', async () => {
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    const res = await GET(
      handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1158201444' }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('1158201444');
  });
});

// ---------------------------------------------------------------------------
// POST — signature
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/whatsapp — signature', () => {
  it('accepts a correctly signed body and applies the status', async () => {
    const row = seed({ status: 'sent' });
    const res = await POST(post(statusBody([{ ref: REF, status: 'delivered' }])));
    expect(res.status).toBe(200);
    expect(row.status).toBe('delivered');
  });

  it('rejects a forged body with 401 and writes nothing', async () => {
    const row = seed({ status: 'sent' });
    const res = await POST(post(statusBody([{ ref: REF, status: 'delivered' }]), { badSig: true }));
    expect(res.status).toBe(401);
    expect(row.status).toBe('sent');
    expect(row.delivered_at).toBeNull();
  });

  it('rejects an unsigned body with 401', async () => {
    const row = seed({ status: 'sent' });
    const res = await POST(post(statusBody([{ ref: REF, status: 'delivered' }]), { sign: false }));
    expect(res.status).toBe(401);
    expect(row.status).toBe('sent');
  });

  it('fails CLOSED when WHATSAPP_APP_SECRET is unset — a valid-looking body is still 401', async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const row = seed({ status: 'sent' });
    const res = await POST(post(statusBody([{ ref: REF, status: 'delivered' }])));
    expect(res.status).toBe(401);
    expect(row.status).toBe('sent');
  });

  it('rejects a signature over a DIFFERENT body (byte-exact verification)', async () => {
    const row = seed({ status: 'sent' });
    const signedOver = JSON.stringify(statusBody([{ ref: REF, status: 'read' }]));
    const digest = createHmac('sha256', APP_SECRET).update(signedOver, 'utf8').digest('hex');
    const req = new Request('http://t/api/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': `sha256=${digest}` },
      // Same object, re-stringified with a space — different bytes, same JSON.
      body: JSON.stringify(statusBody([{ ref: REF, status: 'read' }]), null, 1),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(row.status).toBe('sent');
  });
});

// ---------------------------------------------------------------------------
// POST — the monotonic ladder
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/whatsapp — monotonic statuses', () => {
  it('walks sent → delivered → read, stamping each receipt', async () => {
    const row = seed({ status: 'sent' });

    await POST(post(statusBody([{ ref: REF, status: 'delivered', timestamp: '1754500000' }])));
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).toBe(new Date(1754500000_000).toISOString());

    await POST(post(statusBody([{ ref: REF, status: 'read', timestamp: '1754500060' }])));
    expect(row.status).toBe('read');
    expect(row.read_at).toBe(new Date(1754500060_000).toISOString());
    // The earlier receipt survives the later one.
    expect(row.delivered_at).toBe(new Date(1754500000_000).toISOString());
  });

  it('does NOT downgrade a read row when a late delivered arrives', async () => {
    const row = seed({ status: 'read', read_at: '2026-08-06T18:01:00.000Z' });

    const res = await POST(post(statusBody([{ ref: REF, status: 'delivered', timestamp: '1754500000' }])));

    expect(res.status).toBe(200);
    expect(row.status).toBe('read');
    // The status held, but the delivery timestamp was still news — record it.
    expect(row.delivered_at).toBe(new Date(1754500000_000).toISOString());
  });

  it('does not let a late sent overwrite delivered', async () => {
    const row = seed({ status: 'delivered', delivered_at: '2026-08-06T18:00:00.000Z' });
    await POST(post(statusBody([{ ref: REF, status: 'sent' }])));
    expect(row.status).toBe('delivered');
  });

  it('does not rewrite a receipt already recorded (set-once)', async () => {
    const row = seed({ status: 'read', read_at: '2026-08-06T18:01:00.000Z', delivered_at: '2026-08-06T18:00:00.000Z' });
    await POST(post(statusBody([{ ref: REF, status: 'delivered', timestamp: '1754599999' }])));
    expect(row.delivered_at).toBe('2026-08-06T18:00:00.000Z');
  });

  it('flips a sent row to failed and records Meta’s code and title', async () => {
    const row = seed({ status: 'sent' });
    await POST(
      post(
        statusBody([
          {
            ref: REF,
            status: 'failed',
            errors: [
              {
                code: 131049,
                title: 'Message failed to send due to a quality-based rate limit',
                error_data: { details: 'ignored — free text stays out of the log' },
              },
            ],
          },
        ]),
      ),
    );
    expect(row.status).toBe('failed');
    expect(row.error).toBe('131049: Message failed to send due to a quality-based rate limit');
    expect(row.error).not.toContain('ignored');
  });

  it('never lets a failure overwrite proof the handset got it', async () => {
    const row = seed({ status: 'delivered', delivered_at: '2026-08-06T18:00:00.000Z' });
    await POST(post(statusBody([{ ref: REF, status: 'failed', errors: [{ code: 131026, title: 'unknown' }] }])));
    expect(row.status).toBe('delivered');
    expect(row.error).toBe('');
  });

  it('leaves a skipped row alone — a non-attempt is not a rung on the ladder', async () => {
    const row = seed({ status: 'skipped', provider_ref: '' });
    await POST(post(statusBody([{ ref: '', status: 'delivered' }])));
    expect(row.status).toBe('skipped');
  });

  // The test above cannot detect the loss of the empty-ref guard: 'skipped' sits
  // off the ladder, so the rank guard already blocks it and the row is safe
  // either way. THIS is the one that fails if `if (!ref) continue` is deleted.
  //
  // adapters.ts returns providerRef:'' on every failure and the column is NOT
  // NULL DEFAULT '', so every failed and every queued row in the real table
  // carries the empty string. One callback with an empty message id would match
  // all of them at once.
  it('an empty message id rewrites NOTHING, even rows the ladder would allow', async () => {
    const failedA = seed({ id: 'n1', provider_ref: '', status: 'failed', error: 'whatsapp credentials missing' });
    const failedB = seed({ id: 'n2', provider_ref: '', status: 'failed', error: 'HTTP 401' });
    const queued = seed({ id: 'n3', provider_ref: '', status: 'queued' });

    const res = await POST(post(statusBody([{ ref: '', status: 'delivered' }])));

    expect(res.status).toBe(200);
    // Nothing was even looked up, so this is not "applied" — it never parsed.
    expect(await res.json()).toMatchObject({ applied: 0, ignored: 0, unknown: 0, failed: 0 });
    expect(failedA.status).toBe('failed');
    expect(failedB.status).toBe('failed');
    expect(queued.status).toBe('queued');
    expect(failedA.delivered_at).toBeNull();
    expect(queued.delivered_at).toBeNull();
    // The failure text is the whole story of a failed row and must survive.
    expect(failedA.error).toBe('whatsapp credentials missing');
  });

  it('a valid id in the same batch still applies when another carries an empty id', async () => {
    const orphan = seed({ id: 'n1', provider_ref: '', status: 'failed' });
    const real = seed({ id: 'n2', provider_ref: 'wamid.REAL', status: 'sent' });

    await POST(
      post(
        statusBody([
          { ref: '', status: 'delivered' },
          { ref: 'wamid.REAL', status: 'delivered' },
        ]),
      ),
    );

    expect(real.status).toBe('delivered');
    expect(orphan.status).toBe('failed');
  });

  it('applies every status in a batched payload', async () => {
    const a = seed({ id: 'n1', provider_ref: 'wamid.AAA', status: 'sent' });
    const b = seed({ id: 'n2', provider_ref: 'wamid.BBB', status: 'sent' });
    await POST(
      post(
        statusBody([
          { ref: 'wamid.AAA', status: 'delivered' },
          { ref: 'wamid.BBB', status: 'read' },
        ]),
      ),
    );
    expect(a.status).toBe('delivered');
    expect(b.status).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// POST — everything else answers 200
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/whatsapp — always 200 once signed', () => {
  it('drops an unknown message id with 200 and no write', async () => {
    const row = seed({ provider_ref: 'wamid.OURS', status: 'sent' });
    const res = await POST(post(statusBody([{ ref: 'wamid.SOMEONE-ELSES', status: 'delivered' }])));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unknown: 1, applied: 0 });
    expect(row.status).toBe('sent');
  });

  it('answers 200 to a malformed (non-JSON) body', async () => {
    const res = await POST(post(null, { rawBody: 'not json at all {{{' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, applied: 0 });
  });

  it('answers 200 to a well-formed body with no statuses in it', async () => {
    // An inbound customer message — same webhook, different field.
    const inbound = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'w', changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.X', text: { body: 'hi' } }] } }] }],
    };
    const res = await POST(post(inbound));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: 0, unknown: 0 });
  });

  it('answers 200 to a payload of the wrong shape entirely', async () => {
    const res = await POST(post({ entry: 'not-an-array', statuses: 42 }));
    expect(res.status).toBe(200);
  });

  it('ignores a status Meta added that our column does not know', async () => {
    const row = seed({ status: 'sent' });
    const res = await POST(post(statusBody([{ ref: REF, status: 'deleted' }])));
    expect(res.status).toBe(200);
    expect(row.status).toBe('sent');
  });

  it('answers 200 when the database write fails', async () => {
    seed({ status: 'sent' });
    db.failNextUpdate = true;
    const res = await POST(post(statusBody([{ ref: REF, status: 'delivered' }])));
    expect(res.status).toBe(200);
  });

  // Asserting only `status === 200` cannot detect the loss of the DB-error
  // branch — the fallback path answers 200 too. The tally is the only
  // machine-readable signal this endpoint emits, so a write that FAILED must be
  // distinguishable inside it from a benign no-op. The live case is
  // 2026-08-notify-delivery.sql not being applied: every write is rejected by
  // the old CHECK constraint, and without this the endpoint reports success.
  it('reports a database failure as failed, never as an ordinary ignored no-op', async () => {
    const row = seed({ status: 'sent' });
    db.failNextUpdate = true;

    const res = await POST(post(statusBody([{ ref: REF, status: 'delivered' }])));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, applied: 0, ignored: 0, unknown: 0, failed: 1 });
    expect(row.status).toBe('sent');
  });

  it('a benign already-at-a-higher-rung callback is ignored, not failed', async () => {
    seed({ status: 'read', read_at: '2026-08-06T18:01:00.000Z', delivered_at: '2026-08-06T18:00:00.000Z' });

    const res = await POST(post(statusBody([{ ref: REF, status: 'delivered' }])));

    // Same shape as the test above, opposite counter — that contrast is the
    // point. These two bodies used to be byte-identical.
    expect(await res.json()).toMatchObject({ applied: 0, ignored: 1, unknown: 0, failed: 0 });
  });
});
