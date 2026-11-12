import { describe, expect, it, vi } from 'vitest';
import { INTERRUPTED as FROM_INGEST } from '@/lib/online-settlements/ingest';
import {
  canReportTransition,
  INTERRUPTED,
  isReReadable,
  REPORT_STATE_LABEL,
  REPORT_STATES,
  reportState,
  runThatGoesAhead,
  SYNC_RUN_STALE_MS,
  syncRunState,
  WRITING_REPORT,
} from '@/lib/online-settlements/lifecycle';

// Owner → Online orders: a report's life (the 'writing' state that used to be
// spelled status 'failed' + an error sentence) and a mail-check run's (the
// 'abandoned' run a killed check leaves, which must not block the next).

describe('a settlement report', () => {
  it("reads 'writing' from how it is stored, and nothing else as it", () => {
    expect(WRITING_REPORT).toEqual({ status: 'failed', error: INTERRUPTED });
    expect(FROM_INGEST).toBe(INTERRUPTED);
    expect(reportState({ status: 'failed', error: INTERRUPTED })).toBe('writing');
    expect(reportState({ status: 'failed', error: 'No "Order Level" sheet' })).toBe('failed');
    expect(reportState({ status: 'read', error: null })).toBe('read');
    expect(reportState({ status: 'unsupported', error: 'Not the annexure' })).toBe('unsupported');
    expect(reportState({ status: 'nonsense', error: null })).toBe('failed');
  });

  it('is read again in any state but read', () => {
    for (const s of REPORT_STATES) expect(isReReadable(s), s).toBe(s !== 'read');
  });

  it('becomes read only from writing, and never leaves read', () => {
    expect(canReportTransition('writing', 'read')).toBe(true);
    for (const from of [null, 'unsupported', 'failed'] as const) expect(canReportTransition(from, 'read')).toBe(false);
    for (const to of REPORT_STATES) expect(canReportTransition('read', to)).toBe(false);
    expect(canReportTransition('failed', 'writing')).toBe(true);
    expect(canReportTransition(null, 'writing')).toBe(true);
  });

  it('has the owner words for every state', () => {
    expect(Object.keys(REPORT_STATE_LABEL).sort()).toEqual([...REPORT_STATES].sort());
  });
});

describe('a mail-check run', () => {
  const now = Date.parse('2026-11-12T03:45:00Z');
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it('is running, finished, failed or abandoned', () => {
    expect(syncRunState({ started_at: at(10_000), finished_at: null, error: null }, now)).toBe('running');
    expect(syncRunState({ started_at: at(10_000), finished_at: at(1000), error: null }, now)).toBe('finished');
    expect(syncRunState({ started_at: at(10_000), finished_at: at(1000), error: 'Mail check failed' }, now)).toBe('failed');
    expect(syncRunState({ started_at: at(SYNC_RUN_STALE_MS), finished_at: null, error: null }, now)).toBe('abandoned');
    expect(syncRunState({ started_at: null, finished_at: null, error: null }, now)).toBe('abandoned');
  });

  it('lets the earliest run in flight go ahead, the same answer for everyone', () => {
    const runs = [
      { id: 'b', started_at: at(2000), finished_at: null, error: null },
      { id: 'a', started_at: at(2000), finished_at: null, error: null },
      { id: 'c', started_at: at(1000), finished_at: null, error: null },
      { id: 'old', started_at: at(SYNC_RUN_STALE_MS + 1), finished_at: null, error: null },
      { id: 'done', started_at: at(9000), finished_at: at(8000), error: null },
    ];
    expect(runThatGoesAhead(runs, now)?.id).toBe('a');
    expect(runThatGoesAhead([...runs].reverse(), now)?.id).toBe('a');
    expect(runThatGoesAhead([runs[3], runs[4]], now)).toBeNull();
  });
});

// The two routes that start a check, when another is already in flight.
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => ({}) }));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve({ id: 'owner-1' }) }));
vi.mock('@/lib/online-settlements/sync', () => ({
  runOnlineReportSync: () =>
    Promise.resolve({ configured: true, ok: false, busy: true, runId: null, error: 'Another mail check is running right now — try again in a minute.' }),
}));

describe('a check while another is in flight', () => {
  it('the cron stands down quietly (200, a note), not as a failure that pages', async () => {
    const { GET } = await import('@/app/api/cron/online-reports/route');
    process.env.CRON_SECRET = 'right';
    const res = await GET(new Request('http://t/api/cron/online-reports', { headers: { authorization: 'Bearer right' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, note: expect.stringMatching(/running/) });
    delete process.env.CRON_SECRET;
  });

  it("the owner's Check email now says so (409)", async () => {
    const { POST } = await import('@/app/api/owner/online-reports/sync/route');
    const res = await POST(new Request('http://t', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(409);
  });
});
