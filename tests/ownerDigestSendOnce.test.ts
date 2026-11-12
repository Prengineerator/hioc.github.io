import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/marketingDb';
import { makeMarketingDb } from './helpers/marketingDb';

// sendDigest's send-once log (lib/reports/ownerDigestServer.ts). A scheduled report's
// 'sent' row is now a CLAIM written before the email goes: the old read-sent-rows →
// send → insert let a retried or re-triggered cron run that overlapped the first email
// the owner twice, owner_report_sends_cron_once only rejecting the second LOG row.

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/notifications/adapters', () => ({ emailAdapter: { send: h.send } }));

const { sendDigest, DIGEST_CLAIM_NOTE } = await import('@/lib/reports/ownerDigestServer');

const period = { kind: 'daily' as const, from: '2026-11-11', to: '2026-11-11' };
const email = { subject: 'Yesterday at HIOC', html: '<p>hi</p>', text: 'hi' };
const TO = ['owner@hioc.in', 'accountant@example.com'];

let db: FakeDb;
const sends = () => db.tables.owner_report_sends ?? [];

beforeEach(() => {
  db = makeMarketingDb();
  h.send.mockReset();
  h.send.mockResolvedValue({ ok: true, providerRef: 're_1', error: '' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/**
 * The fake has no partial unique indexes, so model owner_report_sends_cron_once —
 * (kind, period_start, to_email) WHERE status='sent' AND trigger='cron' — on the insert path.
 */
function withCronOnceIndex(client: FakeDb['client']): FakeDb['client'] {
  return {
    ...client,
    from(table: string) {
      const chain = client.from(table) as Record<string, (...a: unknown[]) => unknown>;
      if (table !== 'owner_report_sends') return chain;
      const insert = chain.insert;
      chain.insert = (row: unknown) => {
        const r = row as Record<string, unknown>;
        const inner = insert(row) as Record<string, (...a: unknown[]) => unknown>;
        const run = inner.then;
        // Checked when the statement EXECUTES (like the index), not when the chain is built.
        inner.then = (resolve: unknown, reject: unknown) => {
          const clash =
            r.status === 'sent' &&
            r.trigger === 'cron' &&
            sends().some((s) => s.status === 'sent' && s.trigger === 'cron' && s.kind === r.kind && s.period_start === r.period_start && s.to_email === r.to_email);
          if (!clash) return run(resolve, reject);
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }).then(resolve as never, reject as never);
        };
        return inner;
      };
      return chain;
    },
  };
}

describe('sendDigest — cron claim before send', () => {
  it('claims each address before its email goes, then settles the row', async () => {
    const atSend: unknown[] = [];
    h.send.mockImplementation(async (input: { to: string }) => {
      atSend.push(sends().find((s) => s.to_email === input.to)?.error);
      return { ok: true, providerRef: 're_1', error: '' };
    });
    const out = await sendDigest(withCronOnceIndex(db.client) as never, period, email, TO, 'cron');
    expect(out.map((o) => o.status)).toEqual(['sent', 'sent']);
    expect(atSend).toEqual([DIGEST_CLAIM_NOTE, DIGEST_CLAIM_NOTE]);
    expect(sends().map((s) => [s.status, s.error, s.provider_ref])).toEqual([
      ['sent', '', 're_1'],
      ['sent', '', 're_1'],
    ]);
  });

  it('two overlapping cron runs email each address once', async () => {
    const client = withCronOnceIndex(db.client) as never;
    const [a, b] = await Promise.all([sendDigest(client, period, email, TO, 'cron'), sendDigest(client, period, email, TO, 'cron')]);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect([...a, ...b].map((o) => o.status).sort()).toEqual(['sent', 'sent', 'skipped', 'skipped']);
    expect([...a, ...b].filter((o) => o.status === 'skipped').every((o) => o.detail === 'already sent')).toBe(true);
  });

  it('a refused email steps its claim down to failed, and the next run sends it', async () => {
    const client = withCronOnceIndex(db.client) as never;
    h.send.mockResolvedValueOnce({ ok: false, providerRef: '', error: 'domain not verified' });
    const first = await sendDigest(client, period, email, ['owner@hioc.in'], 'cron');
    expect(first).toEqual([{ to: 'owner@hioc.in', status: 'failed', detail: 'domain not verified' }]);
    expect(sends()[0]).toMatchObject({ status: 'failed', error: 'domain not verified' });
    const second = await sendDigest(client, period, email, ['owner@hioc.in'], 'cron');
    expect(second[0].status).toBe('sent');
  });

  it('a manual "Send now" is an explicit extra copy: it always sends, and logs afterwards', async () => {
    const client = withCronOnceIndex(db.client) as never;
    await sendDigest(client, period, email, ['owner@hioc.in'], 'cron');
    const manual = await sendDigest(client, period, email, ['owner@hioc.in'], 'manual');
    expect(manual[0].status).toBe('sent');
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(sends().map((s) => s.trigger)).toEqual(['cron', 'manual']);
  });
});
