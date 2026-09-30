import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FakeDb, Row } from './helpers/marketingDb';
import { NOW_SEND, newDb, rowsOf } from './helpers/marketingWorld';

// What the WhatsApp webhook does for MARKETING (spec §2, §6 "Webhook changes"):
//   (a) delivery receipts for the agent's own messages, forward-only, 131050 = opt-out
//   (b) START-family keywords, STOP, Meta's "Stop promotions" button and the
//       user_preferences field — all recorded in the consent ledger
//   (c) the new STOP reply text
// …and that a missing marketing migration leaves the old behaviour exactly as it was, and
// that every phone comes from the HMAC-signed payload. tests/whatsappWebhook.test.ts and
// tests/feedbackInboundWebhook.test.ts own the existing behaviour and are unchanged.

const APP_SECRET = 'app-secret-for-tests';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, send: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/notifications/adapters', () => ({ whatsappAdapter: { send: h.send } }));
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve({ google_review_url: 'https://g.page/r/test/review' }) }));

const { POST } = await import('@/app/api/webhooks/whatsapp/route');

const PHONE = '+919876543210';
const WA = '919876543210';
const START_REPLY = "You're subscribed to HIOC offers on WhatsApp — at most one message a week. Reply STOP anytime to unsubscribe.";
const STOP_REPLY =
  "You're unsubscribed from HIOC offers and feedback messages. You'll still get updates about orders you place. Reply START any time to opt back in.";

const wrap = (value: Record<string, unknown>, field = 'messages') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1' }, ...value } }] }],
});
const text = (id: string, body: string, from = WA) => wrap({ messages: [{ id, from, type: 'text', text: { body } }] });
const button = (id: string, label: string, from = WA, payload = '') => wrap({ messages: [{ id, from, type: 'button', button: { text: label, payload } }] });
const statuses = (...s: { id: string; status: string; errors?: unknown[]; timestamp?: string }[]) =>
  wrap({ statuses: s.map((x) => ({ timestamp: '1759650000', recipient_id: WA, ...x })) });
const preferences = (...p: Record<string, unknown>[]) => wrap({ user_preferences: p }, 'user_preferences');

function post(body: unknown, opts: { sign?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign !== false) headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex')}`;
  return POST(new Request('http://t/api/webhooks/whatsapp', { method: 'POST', headers, body: raw }));
}

const db = () => h.db;
const consent = (phone = PHONE) => rowsOf(db(), 'marketing_consent', (r) => r.phone === phone)[0];
const events = () => rowsOf(db(), 'marketing_consent_events');
const recipient = (id: string) => rowsOf(db(), 'marketing_recipients', (r) => r.id === id)[0];
const replies = () => h.send.mock.calls.map((c) => c[0].body as string);

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  h.db = newDb({ startMs: NOW_SEND.getTime() });
  h.db.tables.profiles = [{ id: 'u1', phone: PHONE, phone_verified: true, marketing_consent: true }];
  h.send.mockReset();
  h.send.mockResolvedValue({ ok: true, providerRef: 'wamid.REPLY', error: '' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
describe('(a) delivery receipts for marketing messages', () => {
  const REF = 'wamid.MKT-ONE';
  const seed = (over: Row = {}) => {
    db().tables.marketing_recipients = [
      { id: 'r1', campaign_id: 'c1', phone: PHONE, user_id: 'u1', status: 'sent', provider_ref: REF, sent_at: '2026-10-05T07:00:00.000Z', delivered_at: null, read_at: null, cost_inr: 1.02, error: '', error_code: '', ...over },
    ];
  };

  it('a notification match still wins: the recipient is untouched', async () => {
    seed();
    db().tables.notifications = [{ id: 'n1', provider_ref: REF, status: 'sent', delivered_at: null, read_at: null, error: '' }];
    const res = await post(statuses({ id: REF, status: 'delivered' }));
    expect(await res.json()).toMatchObject({ applied: 1, unknown: 0 });
    expect(rowsOf(db(), 'notifications')[0].status).toBe('delivered');
    expect(recipient('r1').status).toBe('sent');
  });

  it('sent → delivered stamps delivered_at from Meta\'s timestamp', async () => {
    seed();
    const res = await post(statuses({ id: REF, status: 'delivered', timestamp: '1759650000' }));
    expect(await res.json()).toMatchObject({ received: true, applied: 1, unknown: 0, failed: 0 });
    expect(recipient('r1')).toMatchObject({ status: 'delivered', delivered_at: new Date(1759650000 * 1000).toISOString() });
  });

  it('delivered → read stamps read_at', async () => {
    seed({ status: 'delivered', delivered_at: '2026-10-05T07:01:00.000Z' });
    await post(statuses({ id: REF, status: 'read', timestamp: '1759650100' }));
    expect(recipient('r1')).toMatchObject({ status: 'read', read_at: new Date(1759650100 * 1000).toISOString(), delivered_at: '2026-10-05T07:01:00.000Z' });
  });

  it('a read that arrives first also fills in delivery (it implies it)', async () => {
    seed({ status: 'sent' });
    await post(statuses({ id: REF, status: 'read', timestamp: '1759650100' }));
    expect(recipient('r1')).toMatchObject({ status: 'read', delivered_at: new Date(1759650100 * 1000).toISOString() });
  });

  it('is FORWARD-ONLY: a late delivered never un-reads a row, but its timestamp is kept once', async () => {
    seed({ status: 'read', read_at: '2026-10-05T07:05:00.000Z', delivered_at: null });
    const res = await post(statuses({ id: REF, status: 'delivered', timestamp: '1759650000' }));
    expect(await res.json()).toMatchObject({ applied: 0, ignored: 1 });
    expect(recipient('r1')).toMatchObject({ status: 'read', delivered_at: new Date(1759650000 * 1000).toISOString() });

    // A second late callback cannot rewrite the first timestamp.
    await post(statuses({ id: REF, status: 'delivered', timestamp: '1759659999' }));
    expect(recipient('r1').delivered_at).toBe(new Date(1759650000 * 1000).toISOString());
  });

  it.each(['delivered', 'read'])('a repeated %s is ignored', async (status) => {
    seed({ status, delivered_at: 'x', read_at: status === 'read' ? 'y' : null });
    const res = await post(statuses({ id: REF, status }));
    expect(await res.json()).toMatchObject({ applied: 0, ignored: 1 });
  });

  it('"sent" is recorded by the sender itself: the callback changes nothing', async () => {
    seed({ status: 'sent' });
    const res = await post(statuses({ id: REF, status: 'sent' }));
    expect(await res.json()).toMatchObject({ applied: 0, ignored: 1 });
    expect(recipient('r1').status).toBe('sent');
  });

  it('failed from sent: cost becomes 0 (Meta did not charge), the code and error are stored', async () => {
    seed();
    const res = await post(
      statuses({ id: REF, status: 'failed', errors: [{ code: 131049, title: 'Message not delivered to maintain healthy ecosystem engagement', error_data: { details: 'secret detail' } }] }),
    );
    expect(await res.json()).toMatchObject({ applied: 1 });
    expect(recipient('r1')).toMatchObject({ status: 'failed', cost_inr: 0, error_code: '131049', error: '131049: Message not delivered to maintain healthy ecosystem engagement' });
    // 131049 is Meta's frequency cap, not the customer's choice: no opt-out.
    expect(rowsOf(db(), 'marketing_consent')).toEqual([]);
  });

  it('failed from sending works too (the sender had not recorded "sent" yet)', async () => {
    seed({ status: 'sending' });
    await post(statuses({ id: REF, status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] }));
    expect(recipient('r1')).toMatchObject({ status: 'failed', cost_inr: 0 });
  });

  it.each(['delivered', 'read'])('a failure never overwrites proof of delivery (%s)', async (status) => {
    seed({ status });
    const res = await post(statuses({ id: REF, status: 'failed', errors: [{ code: 1, title: 'x' }] }));
    expect(await res.json()).toMatchObject({ applied: 0, ignored: 1 });
    expect(recipient('r1')).toMatchObject({ status, cost_inr: 1.02 });
  });

  it('131050 (the customer tapped "Stop promotions") is an OPT-OUT, and cancels what is still queued for them', async () => {
    seed();
    db().tables.marketing_recipients.push({ id: 'r2', campaign_id: 'c2', phone: PHONE, status: 'queued', provider_ref: '' });
    await post(statuses({ id: REF, status: 'failed', errors: [{ code: 131050, title: 'User stopped marketing messages' }] }));

    expect(consent()).toMatchObject({ status: 'opted_out', source: 'meta_131050', user_id: 'u1' });
    expect(rowsOf(db(), 'whatsapp_opt_outs')[0]).toMatchObject({ phone: PHONE, source: 'marketing:meta_131050' });
    expect(events()[0]).toMatchObject({ action: 'opt_out', source: 'meta_131050' });
    expect(recipient('r2')).toMatchObject({ status: 'cancelled', skip_reason: 'opted_out' });
  });

  it('a duplicate 131050 callback records the opt-out once', async () => {
    seed();
    const body = statuses({ id: REF, status: 'failed', errors: [{ code: 131050, title: 'x' }] });
    await post(body);
    await post(body);
    expect(events()).toHaveLength(1);
  });

  it('an unknown id is unknown, exactly as before', async () => {
    seed();
    const res = await post(statuses({ id: 'wamid.SOMEONE-ELSES', status: 'delivered' }));
    expect(await res.json()).toMatchObject({ applied: 0, unknown: 1 });
    expect(recipient('r1').status).toBe('sent');
  });

  it('an EMPTY provider_ref never matches the recipients that have none yet', async () => {
    seed({ provider_ref: '', status: 'queued' });
    const res = await post(statuses({ id: '', status: 'delivered' }));
    expect(res.status).toBe(200);
    expect(recipient('r1').status).toBe('queued');
  });

  it('with the marketing tables missing it falls through to "unknown" — 200, nothing thrown', async () => {
    db().setMissing('marketing_recipients', true);
    const res = await post(statuses({ id: REF, status: 'delivered' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: 0, unknown: 1, failed: 0 });
  });

  it('reports a write that FAILED as failed, not as a benign no-op', async () => {
    seed();
    db().failNext('update marketing_recipients');
    const res = await post(statuses({ id: REF, status: 'delivered' }));
    expect(await res.json()).toMatchObject({ applied: 0, ignored: 0, failed: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('(b) START-family keywords opt IN', () => {
  beforeEach(() => {
    db().tables.feedback_requests = [{ id: 'req-1', order_id: 'order-1', phone: PHONE, unread: false, last_inbound_at: null, created_at: '2026-10-01T00:00:00.000Z' }];
    db().tables.whatsapp_opt_outs = [{ phone: PHONE, source: 'stop_keyword' }];
  });

  it.each(['START', 'start', ' Subscribe ', 'OFFERS', 'unstop'])('%j subscribes the sender and confirms once', async (word) => {
    const res = await post(text('wamid.IN1', word));
    expect(res.status).toBe(200);

    expect(consent()).toMatchObject({ phone: PHONE, status: 'opted_in', source: 'whatsapp_keyword', user_id: 'u1' });
    // Their earlier STOP must not keep blocking feedback messages either.
    expect(rowsOf(db(), 'whatsapp_opt_outs')).toEqual([]);
    expect(events()[0]).toMatchObject({ phone: PHONE, action: 'opt_in', source: 'whatsapp_keyword' });
    expect(replies()).toEqual([START_REPLY]);
    expect(h.send.mock.calls[0][0]).toMatchObject({ to: PHONE, channel: 'whatsapp' });
  });

  it('stores the inbound message the way STOP is stored: in the thread, linked to the latest request, flagged unread', async () => {
    await post(text('wamid.IN2', 'START'));
    const inbound = rowsOf(db(), 'feedback_messages', (m) => m.direction === 'in')[0];
    expect(inbound).toMatchObject({ phone: PHONE, body: 'START', wa_message_id: 'wamid.IN2', request_id: 'req-1', order_id: 'order-1' });
    expect(rowsOf(db(), 'feedback_requests')[0]).toMatchObject({ unread: true });
    // …and so is our reply.
    expect(rowsOf(db(), 'feedback_messages', (m) => m.direction === 'out')[0]).toMatchObject({ body: START_REPLY, status: 'sent' });
  });

  it('a duplicate delivery of the same message opts in and replies ONCE', async () => {
    const body = text('wamid.DUP', 'START');
    await post(body);
    const res = await post(body);
    expect((await res.json()).messages).toMatchObject({ applied: 0, duplicate: 1 });
    expect(events()).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('is the WHOLE message: a sentence containing "start" subscribes no one', async () => {
    await post(text('wamid.S1', 'please start my order'));
    await post(text('wamid.S2', 'START please'));
    expect(rowsOf(db(), 'marketing_consent')).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
    // Ordinary text is still stored for the owner's inbox.
    expect(rowsOf(db(), 'feedback_messages', (m) => m.direction === 'in')).toHaveLength(2);
  });

  it('only a TYPED message counts — a button labelled START does not', async () => {
    await post(button('wamid.B1', 'START'));
    expect(rowsOf(db(), 'marketing_consent')).toEqual([]);
  });

  it('with the marketing tables missing it is stored as plain text: no reply that would be a lie, no error', async () => {
    db().setMissing('marketing_consent', true);
    const res = await post(text('wamid.M1', 'START'));
    expect(res.status).toBe(200);
    expect(h.send).not.toHaveBeenCalled();
    expect(rowsOf(db(), 'feedback_messages', (m) => m.direction === 'in')[0]).toMatchObject({ body: 'START' });
    // The old behaviour, unchanged: the STOP row is not removed (nothing was subscribed).
    expect(rowsOf(db(), 'whatsapp_opt_outs')).toHaveLength(1);
  });

  it('takes the phone ONLY from the signed payload', async () => {
    await post(text('wamid.P1', 'START', '919111111111'));
    expect(consent('+919111111111')).toMatchObject({ status: 'opted_in' });
    expect(consent(PHONE)).toBeUndefined();
  });

  it('an unsigned message opts in no one', async () => {
    const res = await post(text('wamid.U1', 'START'), { sign: false });
    expect(res.status).toBe(401);
    expect(rowsOf(db(), 'marketing_consent')).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('(b)+(c) STOP: the old behaviour, plus the marketing opt-out and the new reply', () => {
  beforeEach(() => {
    db().tables.marketing_consent = [{ phone: PHONE, user_id: 'u1', status: 'opted_in', source: 'profile' }];
    db().tables.marketing_recipients = [
      { id: 'q1', campaign_id: 'c1', phone: PHONE, status: 'queued' },
      { id: 'p1', campaign_id: 'c2', phone: PHONE, status: 'pending' },
      { id: 'other', campaign_id: 'c1', phone: '+919111111111', status: 'queued' },
    ];
  });

  it('records BOTH opt-outs, cancels the queue, and replies with the new text exactly once', async () => {
    const res = await post(text('wamid.STOP1', 'stop'));
    expect(res.status).toBe(200);

    // Legacy: the row the feedback cron honours keeps its source.
    expect(rowsOf(db(), 'whatsapp_opt_outs')).toEqual([expect.objectContaining({ phone: PHONE, source: 'stop_keyword' })]);
    // Marketing: ledger, audit event, profile checkbox, queue.
    expect(consent()).toMatchObject({ status: 'opted_out', source: 'stop_keyword' });
    expect(events()[0]).toMatchObject({ action: 'opt_out', source: 'stop_keyword' });
    expect(rowsOf(db(), 'profiles')[0].marketing_consent).toBe(false);
    expect(recipient('q1')).toMatchObject({ status: 'cancelled', skip_reason: 'opted_out' });
    expect(recipient('p1').status).toBe('cancelled');
    expect(recipient('other').status).toBe('queued');
    expect(replies()).toEqual([STOP_REPLY]);
  });

  it('UNSUBSCRIBE too; and STOP inside a sentence is not STOP', async () => {
    await post(text('wamid.STOP2', 'UNSUBSCRIBE'));
    expect(consent().status).toBe('opted_out');

    db().tables.marketing_consent = [{ phone: PHONE, status: 'opted_in', source: 'profile' }];
    await post(text('wamid.STOP3', 'please stop calling me at odd hours'));
    expect(consent().status).toBe('opted_in');
  });

  it('with the marketing tables missing the legacy opt-out and the reply still happen', async () => {
    db().setMissing('marketing_consent', true);
    const res = await post(text('wamid.STOP4', 'STOP'));
    expect(res.status).toBe(200);
    expect(rowsOf(db(), 'whatsapp_opt_outs')).toEqual([expect.objectContaining({ phone: PHONE, source: 'stop_keyword' })]);
    expect(replies()).toEqual([STOP_REPLY]);
  });

  it('a failure in the marketing ledger never blocks the legacy opt-out', async () => {
    db().failNext('upsert marketing_consent');
    await post(text('wamid.STOP5', 'STOP'));
    expect(rowsOf(db(), 'whatsapp_opt_outs')).toHaveLength(1);
    expect(replies()).toEqual([STOP_REPLY]);
  });

  it('STOP from one phone never touches another phone\'s consent', async () => {
    db().tables.marketing_consent.push({ phone: '+919111111111', status: 'opted_in', source: 'profile' });
    await post(text('wamid.STOP6', 'STOP'));
    expect(consent('+919111111111')).toMatchObject({ status: 'opted_in' });
  });

  it('a duplicate delivery opts out and confirms once', async () => {
    const body = text('wamid.STOPDUP', 'STOP');
    await post(body);
    await post(body);
    expect(events()).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('(b) Meta\'s "Stop promotions" button', () => {
  beforeEach(() => {
    db().tables.marketing_consent = [{ phone: PHONE, user_id: 'u1', status: 'opted_in', source: 'profile' }];
    db().tables.marketing_recipients = [{ id: 'q1', campaign_id: 'c1', phone: PHONE, status: 'queued' }];
    db().tables.feedback_requests = [{ id: 'req-1', order_id: 'order-1', phone: PHONE, rating: null, unread: false, created_at: '2026-10-01T00:00:00.000Z' }];
  });

  it.each(['Stop promotions', 'stop promotions', ' STOP PROMOTIONS '])('%j opts out — with NO reply (Meta confirms to the customer)', async (label) => {
    const res = await post(button(`wamid.SP-${label.length}`, label, WA, 'meta-opaque-payload'));
    expect(res.status).toBe(200);
    expect(consent()).toMatchObject({ status: 'opted_out', source: 'stop_promotions' });
    expect(events()[0]).toMatchObject({ action: 'opt_out', source: 'stop_promotions' });
    expect(recipient('q1').status).toBe('cancelled');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('is stored in the thread but is not mistaken for a feedback rating', async () => {
    await post(button('wamid.SP1', 'Stop promotions', WA, 'meta-opaque-payload'));
    expect(rowsOf(db(), 'feedback_messages')[0]).toMatchObject({ direction: 'in', body: 'Stop promotions', button_payload: 'meta-opaque-payload' });
    expect(rowsOf(db(), 'feedback_requests')[0]).toMatchObject({ rating: null, unread: false });
  });

  it('also works as an interactive button reply', async () => {
    const msg = wrap({ messages: [{ id: 'wamid.SP2', from: WA, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'Stop promotions' } } }] });
    await post(msg);
    expect(consent().status).toBe('opted_out');
  });

  it('typed text "Stop promotions" is not the button (and not STOP) — it is just a message', async () => {
    await post(text('wamid.SP3', 'Stop promotions'));
    expect(consent().status).toBe('opted_in');
  });

  it('a feedback button tap is untouched: it rates, and does NOT opt anyone out', async () => {
    await post(button('wamid.FB1', '😍 Loved it', WA, 'fb:req-1:5'));
    expect(rowsOf(db(), 'feedback_requests')[0]).toMatchObject({ rating: 5 });
    expect(consent().status).toBe('opted_in');
  });

  it('with the marketing tables missing it is stored and nothing else', async () => {
    db().setMissing('marketing_consent', true);
    const res = await post(button('wamid.SP4', 'Stop promotions'));
    expect(res.status).toBe(200);
    expect(rowsOf(db(), 'feedback_messages')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('(b) the user_preferences field', () => {
  const pref = (value: string, over: Record<string, unknown> = {}) => ({ wa_id: WA, category: 'marketing_messages', value, detail: 'x', timestamp: '1759650000', ...over });

  beforeEach(() => {
    db().tables.marketing_consent = [{ phone: PHONE, user_id: 'u1', status: 'opted_in', source: 'profile' }];
    db().tables.marketing_recipients = [{ id: 'q1', campaign_id: 'c1', phone: PHONE, status: 'queued' }];
  });

  it('stop → opt-out (meta_stop), silently', async () => {
    const res = await post(preferences(pref('stop')));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, preferences: 1 });
    expect(consent()).toMatchObject({ status: 'opted_out', source: 'meta_stop' });
    expect(recipient('q1').status).toBe('cancelled');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('resume → opt-in (meta_resume) ONLY when we already hold an earlier opt-in of theirs', async () => {
    db().tables.marketing_consent = [{ phone: PHONE, status: 'opted_out', source: 'meta_stop' }];
    await post(preferences(pref('resume')));
    // No opt_in event ever: Meta saying "resume" is not consent to us.
    expect(consent().status).toBe('opted_out');
    expect(events()).toEqual([]);

    db().tables.marketing_consent_events = [{ id: 'e0', phone: PHONE, action: 'opt_in', source: 'profile' }];
    await post(preferences(pref('resume')));
    expect(consent()).toMatchObject({ status: 'opted_in', source: 'meta_resume' });
  });

  it('ignores other categories, unknown values and malformed ids', async () => {
    const res = await post(preferences(pref('stop', { category: 'utility_messages' }), pref('pause'), pref('stop', { wa_id: 'not-digits' }), pref('stop', { wa_id: undefined })));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('preferences');
    expect(consent().status).toBe('opted_in');
  });

  it('handles several entries in one delivery, each for its own phone', async () => {
    db().tables.marketing_consent.push({ phone: '+919111111111', status: 'opted_in', source: 'profile' });
    await post(preferences(pref('stop'), pref('stop', { wa_id: '919111111111' })));
    expect(consent().status).toBe('opted_out');
    expect(consent('+919111111111').status).toBe('opted_out');
  });

  it('with the marketing tables missing it answers 200 and does nothing', async () => {
    db().setMissing('marketing_consent', true);
    const res = await post(preferences(pref('stop')));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('preferences');
  });

  it('an UNSIGNED preference change is refused: a stranger cannot opt anyone out (or in)', async () => {
    const res = await post(preferences(pref('stop')), { sign: false });
    expect(res.status).toBe(401);
    expect(consent().status).toBe('opted_in');
  });

  it('the response of an ordinary delivery has no preferences key', async () => {
    const res = await post(statuses({ id: 'wamid.NOPE', status: 'delivered' }));
    expect(await res.json()).toEqual({ received: true, applied: 0, ignored: 0, unknown: 1, failed: 0, messages: { applied: 0, duplicate: 0 } });
  });
});
