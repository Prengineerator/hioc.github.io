import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The weekly usage-data purge (app/api/cron/purge-traffic): it fails closed
// without the secret, deletes traffic_events AND suggestion_wizard_steps rows
// older than 13 months with one cutoff, treats a table that has not been
// created yet as a no-op, and never lets a failure on one table stop the other
// from being purged.

type PgError = { code?: string; message?: string };

const state: {
  deletes: { table: string; options: unknown; column: string; cutoff: string }[];
  counts: Record<string, number>;
  errors: Record<string, PgError | null>;
} = { deletes: [], counts: {}, errors: {} };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => ({
      delete: (options: unknown) => ({
        lt: (column: string, cutoff: string) => {
          state.deletes.push({ table, options, column, cutoff });
          const error = state.errors[table] ?? null;
          return Promise.resolve(error ? { error, count: null } : { error: null, count: state.counts[table] ?? 0 });
        },
      }),
    }),
  }),
}));

const { GET } = await import('@/app/api/cron/purge-traffic/route');

function cronReq(secret?: string) {
  return new Request('http://t/api/cron/purge-traffic', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

const DAY_MS = 86_400_000;
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.deletes = [];
  state.counts = {};
  state.errors = {};
  process.env.CRON_SECRET = 'cron-secret';
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  errorSpy.mockRestore();
});

describe('GET /api/cron/purge-traffic', () => {
  it('fails closed: no secret configured, no header, or the wrong one — and deletes nothing', async () => {
    expect((await GET(cronReq())).status).toBe(401);
    expect((await GET(cronReq('wrong'))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(cronReq('cron-secret'))).status).toBe(401);
    expect((await GET(cronReq('undefined'))).status).toBe(401);
    expect(state.deletes).toEqual([]);
  });

  it('deletes rows older than 13 months from both tables, with one cutoff', async () => {
    state.counts = { traffic_events: 12, suggestion_wizard_steps: 5 };
    const before = Date.now();
    const res = await GET(cronReq('cron-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, deleted: 12, wizardStepsDeleted: 5 });
    expect(body.note).toBeUndefined();

    expect(state.deletes.map((d) => [d.table, d.column])).toEqual([
      ['traffic_events', 'created_at'],
      ['suggestion_wizard_steps', 'created_at'],
    ]);
    expect(state.deletes[0].cutoff).toBe(body.cutoff);
    expect(state.deletes[1].cutoff).toBe(body.cutoff);
    // 400 days: the 13 months the privacy policy states.
    const cutoff = new Date(body.cutoff).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - 400 * DAY_MS - 5_000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 400 * DAY_MS + 5_000);
  });

  it('is a no-op for the wizard steps before their SQL file is applied, and still purges traffic', async () => {
    state.counts = { traffic_events: 3 };
    state.errors.suggestion_wizard_steps = {
      code: 'PGRST205',
      message: "Could not find the table 'public.suggestion_wizard_steps' in the schema cache",
    };
    const res = await GET(cronReq('cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      deleted: 3,
      wizardStepsDeleted: 0,
      note: 'suggestion_wizard_steps not created yet',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still purges the wizard steps when the traffic table is the one that is missing', async () => {
    state.counts = { suggestion_wizard_steps: 7 };
    state.errors.traffic_events = { code: '42P01', message: 'relation "traffic_events" does not exist' };
    const res = await GET(cronReq('cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      deleted: 0,
      wizardStepsDeleted: 7,
      note: 'traffic_events not created yet',
    });
  });

  it('names both when neither table exists yet', async () => {
    state.errors.traffic_events = { code: 'PGRST205', message: "Could not find the table 'public.traffic_events'" };
    state.errors.suggestion_wizard_steps = { code: '42P01', message: 'relation "suggestion_wizard_steps" does not exist' };
    const body = await (await GET(cronReq('cron-secret'))).json();
    expect(body).toMatchObject({ ok: true, deleted: 0, wizardStepsDeleted: 0 });
    expect(body.note).toBe('traffic_events not created yet; suggestion_wizard_steps not created yet');
  });

  it('answers 500 when a delete really fails — after trying the other table all the same', async () => {
    state.counts = { suggestion_wizard_steps: 2 };
    state.errors.traffic_events = { code: '57014', message: 'canceling statement due to statement timeout' };
    let res = await GET(cronReq('cron-secret'));
    expect(res.status).toBe(500);
    expect(state.deletes.map((d) => d.table)).toEqual(['traffic_events', 'suggestion_wizard_steps']);

    state.deletes = [];
    state.errors = { suggestion_wizard_steps: { code: '42501', message: 'permission denied for table suggestion_wizard_steps' } };
    res = await GET(cronReq('cron-secret'));
    expect(res.status).toBe(500);
    expect(state.deletes.map((d) => d.table)).toEqual(['traffic_events', 'suggestion_wizard_steps']);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
