import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/marketingDb';
import { makeMarketingDb } from './helpers/marketingDb';

// The feedback request's delivery machine and the owner's thread machine
// (lib/feedback/deliveryState.ts, lib/feedback/threadState.ts) and the bugs they fix:
//   - VERIFIED: the engine answers { sent: true, skipped: 'already_sent' } and the old
//     send.ts treated it as a fresh send, overwriting token_hash with a token that was
//     never delivered — the customer's working link then 404'd;
//   - a failed forced resend on a 'sent' request wrote 'failed' (sent_at still set), so
//     the summary stopped counting a request the customer had received;
//   - the cron's unguarded skip could overwrite a concurrent resend's 'sent';
//   - a new message or a low rating on a RESOLVED thread never reopened it.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  engine: vi.fn(),
  owner: { id: 'owner-1' } as { id: string } | null,
}));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/notifications/engine', () => ({ sendFeedbackRequestNotification: h.engine }));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(h.owner) }));

const delivery = await import('@/lib/feedback/deliveryState');
const thread = await import('@/lib/feedback/threadState');
const { sendFeedbackTemplate } = await import('@/lib/feedback/send');
const { recordInboundOnThread } = await import('@/lib/feedback/inbound');
const { hashFeedbackToken } = await import('@/lib/feedback/token');
const { PATCH } = await import('@/app/api/owner/feedback/[id]/route');

const REQ_ID = '11111111-1111-4111-8111-111111111111';
const request = { id: REQ_ID, order_id: 'order-1', phone: '+919876543210', customer_name: 'Priya' };
const row = () => h.db.tables.feedback_requests[0];

function seed(over: Record<string, unknown> = {}) {
  h.db.tables.feedback_requests = [
    {
      id: REQ_ID,
      order_id: 'order-1',
      phone: '+919876543210',
      status: 'pending',
      sent_at: null,
      token_hash: null,
      provider_ref: '',
      skip_reason: '',
      thread_status: 'open',
      unread: false,
      rating: null,
      ...over,
    },
  ];
}

beforeEach(() => {
  h.db = makeMarketingDb({ unique: { feedback_requests: [['token_hash']] } });
  h.engine.mockReset();
  h.owner = { id: 'owner-1' };
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
describe('the delivery transition table', () => {
  const S = delivery.FEEDBACK_DELIVERY_STATUSES;
  const allowed = (actor: 'cron' | 'owner_resend') =>
    S.flatMap((from) => S.filter((to) => delivery.canTransitionDelivery(from, to, { actor }).ok).map((to) => `${from}→${to}`));

  it('the cron only ever moves a request out of pending', () => {
    expect(allowed('cron').sort()).toEqual(['pending→failed', 'pending→sent', 'pending→skipped']);
    expect([...delivery.CRON_TERMINAL_STATUSES].sort()).toEqual(['failed', 'sent', 'skipped']);
    expect(delivery.deliveryFromStates('skipped', 'cron')).toEqual(['pending']);
  });

  it('an owner resend can retry anything — but nothing un-sends a sent request', () => {
    const owner = allowed('owner_resend');
    expect(owner).toContain('sent→sent');
    expect(owner).toContain('failed→sent');
    expect(owner).toContain('skipped→sent');
    expect(owner).not.toContain('sent→failed');
    expect(owner).not.toContain('sent→skipped');
    expect(owner).not.toContain('sent→pending');
    expect(delivery.deliveryFromStates('failed', 'owner_resend')).not.toContain('sent');
    expect(delivery.canTransitionDelivery('sent', 'failed', { actor: 'owner_resend' })).toMatchObject({ ok: false, code: 'illegal_transition' });
    expect(delivery.canTransitionDelivery('failed', 'sent', { actor: 'cron' })).toMatchObject({ ok: false, code: 'not_allowed' });
  });

  it('maps every engine answer to one outcome', () => {
    expect(delivery.outcomeOfEngineResult({ sent: true, providerRef: 'x' } as never)).toEqual({ outcome: 'sent', reason: '' });
    expect(delivery.outcomeOfEngineResult({ sent: true, skipped: 'already_sent' })).toEqual({ outcome: 'already_sent', reason: '' });
    expect(delivery.outcomeOfEngineResult({ sent: false, skipped: 'in_flight' })).toEqual({ outcome: 'deferred', reason: 'in_flight' });
    expect(delivery.outcomeOfEngineResult({ sent: false, skipped: 'not_configured:X' })).toEqual({ outcome: 'skipped', reason: 'not_configured:X' });
    expect(delivery.outcomeOfEngineResult({ sent: false, error: 'boom' })).toEqual({ outcome: 'failed', reason: 'boom' });
    expect(delivery.statusForOutcome('deferred')).toBeNull();
    expect(delivery.statusForOutcome('already_sent')).toBe('sent');
  });

  it('the claim sub-state: a pending row with a fresh claimed_at is held; a stale one is not', () => {
    const now = Date.parse('2026-11-12T10:00:00.000Z');
    expect(delivery.isClaimed({ status: 'pending', claimed_at: '2026-11-12T09:55:00.000Z' }, now)).toBe(true);
    expect(delivery.isClaimed({ status: 'pending', claimed_at: '2026-11-12T09:49:00.000Z' }, now)).toBe(false);
    expect(delivery.isClaimed({ status: 'pending', claimed_at: null }, now)).toBe(false);
    expect(delivery.isClaimed({ status: 'sent', claimed_at: '2026-11-12T09:59:00.000Z' }, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('sendFeedbackTemplate', () => {
  it('a fresh send stores the hash of the token that actually went out', async () => {
    seed();
    h.engine.mockResolvedValue({ sent: true, providerRef: 'wamid.1' });
    const r = await sendFeedbackTemplate(request, 1089, { admin: h.db.client as never });
    const token = h.engine.mock.calls[0][0].token as string;
    expect(r).toEqual({ sent: true, reason: '', outcome: 'sent' });
    expect(row()).toMatchObject({ status: 'sent', provider_ref: 'wamid.1', token_hash: hashFeedbackToken(token) });
    expect(row().sent_at).toEqual(expect.any(String));
  });

  it("VERIFIED BUG: 'already_sent' never overwrites the token the customer holds", async () => {
    // A second cron run re-claimed the row while the first was still finishing; the first
    // recorded the link it delivered (H1). The engine tells the second it was already sent.
    seed({ status: 'sent', token_hash: 'H1', sent_at: '2026-11-12T09:00:00.000Z', provider_ref: 'wamid.1' });
    h.engine.mockResolvedValue({ sent: true, skipped: 'already_sent', providerRef: 'wamid.1' });
    const r = await sendFeedbackTemplate(request, 1089, { admin: h.db.client as never });
    expect(r.outcome).toBe('already_sent');
    expect(row()).toMatchObject({ status: 'sent', token_hash: 'H1', sent_at: '2026-11-12T09:00:00.000Z' });
  });

  it("'already_sent' on a still-pending row (its run died after sending) marks it sent — without a token", async () => {
    seed();
    h.engine.mockResolvedValue({ sent: true, skipped: 'already_sent', providerRef: 'wamid.1' });
    await sendFeedbackTemplate(request, 1089, { admin: h.db.client as never });
    expect(row()).toMatchObject({ status: 'sent', provider_ref: 'wamid.1', token_hash: null });
  });

  it('a failed forced resend on a sent request leaves it sent (sent_at and link intact)', async () => {
    seed({ status: 'sent', token_hash: 'H1', sent_at: '2026-11-10T09:00:00.000Z' });
    h.engine.mockResolvedValue({ sent: false, error: 'Template paused' });
    const r = await sendFeedbackTemplate(request, 1089, { force: true, admin: h.db.client as never });
    expect(r).toEqual({ sent: false, reason: 'Template paused', outcome: 'failed' });
    expect(row()).toMatchObject({ status: 'sent', token_hash: 'H1', sent_at: '2026-11-10T09:00:00.000Z' });
  });

  it('a failed forced resend on a pending/skipped request does record the failure', async () => {
    seed({ status: 'skipped', skip_reason: 'not_configured:X' });
    h.engine.mockResolvedValue({ sent: false, error: 'Template paused' });
    await sendFeedbackTemplate(request, 1089, { force: true, admin: h.db.client as never });
    expect(row()).toMatchObject({ status: 'failed', skip_reason: 'Template paused' });
  });

  it('a forced resend that goes out re-mints the link over a sent request', async () => {
    seed({ status: 'sent', token_hash: 'H1' });
    h.engine.mockResolvedValue({ sent: true, providerRef: 'wamid.2' });
    await sendFeedbackTemplate(request, 1089, { force: true, admin: h.db.client as never });
    expect(row().token_hash).toBe(hashFeedbackToken(h.engine.mock.calls[0][0].token as string));
    expect(row().token_hash).not.toBe('H1');
  });

  it('the cron never moves a request an owner resend already moved on', async () => {
    seed({ status: 'sent', token_hash: 'H-OWNER' });
    h.engine.mockResolvedValue({ sent: false, error: 'boom' });
    await sendFeedbackTemplate(request, 1089, { admin: h.db.client as never });
    expect(row()).toMatchObject({ status: 'sent', token_hash: 'H-OWNER' });
  });

  it('a send in flight elsewhere writes nothing, so the next run reads the outcome', async () => {
    seed({ claimed_at: '2026-11-12T09:59:00.000Z' });
    h.engine.mockResolvedValue({ sent: false, skipped: 'in_flight' });
    const r = await sendFeedbackTemplate(request, 1089, { admin: h.db.client as never });
    expect(r.outcome).toBe('deferred');
    expect(row()).toMatchObject({ status: 'pending', token_hash: null });
    expect(h.db.log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('the thread transition table + "needs attention"', () => {
  const S = thread.FEEDBACK_THREAD_STATUSES;

  it('the owner may move a thread between any two statuses (the picker offers all three)', () => {
    for (const from of S) for (const to of S) expect(thread.canTransitionThread(from, to, { actor: 'owner' }).ok).toBe(true);
    expect(thread.THREAD_STATUS_OPTIONS.map((o) => o.value)).toEqual(['open', 'in_progress', 'resolved']);
  });

  it('a customer event can only reopen a resolved thread', () => {
    const moves = S.flatMap((from) => S.filter((to) => thread.canTransitionThread(from, to, { actor: 'customer' }).ok).map((to) => `${from}→${to}`));
    expect(moves).toEqual(['resolved→open']);
    expect(thread.REOPENED_BY_INBOUND).toEqual(['resolved']);
  });

  it('rejects nonsense statuses', () => {
    for (const v of ['closed', '', null, 3, 'OPEN']) expect(thread.isThreadStatus(v)).toBe(false);
  });

  it.each([
    [{ thread_status: 'open', unread: true, rating: null }, true],
    [{ thread_status: 'in_progress', unread: false, rating: 3 }, true],
    [{ thread_status: 'open', unread: false, rating: 4 }, false],
    [{ thread_status: 'open', unread: false, rating: null }, false],
    [{ thread_status: 'resolved', unread: true, rating: 1 }, false],
  ])('needsAttention(%j) = %s', (r, want) => {
    expect(thread.needsAttention(r)).toBe(want);
  });

  it('the list route and the dashboard count share ONE query spelling of it', () => {
    const calls: string[] = [];
    const q = {
      neq: (c: string, v: string) => (calls.push(`neq ${c} ${v}`), q),
      or: (f: string) => (calls.push(`or ${f}`), q),
    };
    expect(thread.whereNeedsAttention(q)).toBe(q);
    expect(calls).toEqual(['neq thread_status resolved', 'or unread.eq.true,rating.lte.3']);
  });
});

describe('an inbound customer event reopens a resolved thread', () => {
  it.each([
    ['resolved', 'open'],
    ['in_progress', 'in_progress'],
    ['open', 'open'],
  ])('%s → %s, and always unread', async (from, to) => {
    seed({ thread_status: from });
    await recordInboundOnThread(h.db.client as never, REQ_ID, { rating: 1, last_inbound_at: '2026-11-12T10:00:00.000Z' });
    expect(row()).toMatchObject({ thread_status: to, unread: true, rating: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('PATCH /api/owner/feedback/[id] — thread status', () => {
  const patch = (body: unknown) =>
    PATCH(
      new Request(`http://t/api/owner/feedback/${REQ_ID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: { id: REQ_ID } },
    );

  it('moves the thread through the machine', async () => {
    seed({ thread_status: 'open' });
    const res = await patch({ thread_status: 'resolved' });
    expect(res.status).toBe(200);
    expect(row().thread_status).toBe('resolved');
  });

  it('rejects a nonsense status with 400 and writes nothing', async () => {
    seed();
    const res = await patch({ thread_status: 'closed' });
    expect(res.status).toBe(400);
    expect(h.db.log).toEqual([]);
  });

  it("409s when a customer message reopened the thread between the owner's decision and the write", async () => {
    seed({ thread_status: 'in_progress' });
    h.db.beforeNext('update feedback_requests', () => {
      row().thread_status = 'open';
    });
    const res = await patch({ thread_status: 'resolved' });
    expect(res.status).toBe(409);
    expect(row().thread_status).toBe('open');
  });

  it('other fields still save without a status in the body', async () => {
    seed();
    const res = await patch({ owner_notes: 'called them back' });
    expect(res.status).toBe(200);
    expect(row().owner_notes).toBe('called them back');
  });
});
