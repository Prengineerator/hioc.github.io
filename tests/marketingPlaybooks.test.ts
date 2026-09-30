import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb, Row } from './helpers/marketingDb';
import { NOW_SEND, daysAgo, newDb, rowsOf, seedPlaybooks, seedSettings } from './helpers/marketingWorld';

// The owner's view and edit of the five playbooks (spec §6). Real
// lib/marketing/server/playbooks.ts over an in-memory database.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));

const { listPlaybookViews, patchPlaybook } = await import('@/lib/marketing/server/playbooks');

const db = () => h.db;
const pb = (key: string) => rowsOf(db(), 'marketing_playbooks', (r) => r.key === key)[0];

beforeEach(() => {
  h.db = newDb();
  seedSettings(db());
  seedPlaybooks(db(), { winback_1: 'review' });
});

describe('listPlaybookViews', () => {
  it('returns all five in priority order, with label, description and the learned rate', async () => {
    const views = await listPlaybookViews(NOW_SEND);
    expect(views.map((v) => v.key)).toEqual(['points_expiring', 'winback_3', 'winback_2', 'winback_1', 'points_balance']);
    const w1 = views.find((v) => v.key === 'winback_1')!;
    expect(w1).toMatchObject({ mode: 'review', label: 'Win-back · stage 1 (we miss you)', prior_conversion_pct: 12 });
    expect(w1.description).toMatch(/gone quiet/);
    // No results yet: the learned rate IS the research prior.
    expect(w1.learned_conversion_pct).toBeCloseTo(12);
  });

  it('the learned rate blends the prior with what this cafe achieved: (prior × 50 + conversions) ÷ (50 + treated)', async () => {
    pb('winback_1').observed_treated = 50;
    pb('winback_1').observed_conversions = 25;
    const w1 = (await listPlaybookViews(NOW_SEND)).find((v) => v.key === 'winback_1')!;
    expect(w1.learned_conversion_pct).toBeCloseTo(31);
    expect(w1).toMatchObject({ observed_treated: 50, observed_conversions: 25 });
  });

  it('lists the last runs of THAT playbook, newest first, without message previews', async () => {
    const tpl = { name: 't', lang: 'en', vars: ['first_name'], url_button: false, body_preview: 'Hi {{1}}' };
    db().tables.marketing_campaigns = [
      { id: 'a', kind: 'playbook', playbook_key: 'winback_1', name: 'A', status: 'completed', template: tpl, created_at: daysAgo(9) },
      { id: 'b', kind: 'playbook', playbook_key: 'winback_1', name: 'B', status: 'pending_approval', template: tpl, created_at: daysAgo(1) },
      { id: 'c', kind: 'playbook', playbook_key: 'winback_2', name: 'C', status: 'completed', template: tpl, created_at: daysAgo(2) },
    ];
    db().tables.marketing_recipients = [{ id: 'r', campaign_id: 'b', phone: '+919111111111', arm: 'treatment', status: 'pending', first_name: 'Asha', vars: { first_name: 'Asha' }, created_at: daysAgo(1) }];
    const w1 = (await listPlaybookViews(NOW_SEND)).find((v) => v.key === 'winback_1')!;
    expect(w1.last_runs.map((c) => c.id)).toEqual(['b', 'a']);
    // 'b' is awaiting approval — a campaign list would carry samples, a playbook card must not.
    expect(w1.last_runs[0].samples).toEqual([]);
  });

  it('caps last runs at 5', async () => {
    db().tables.marketing_campaigns = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, kind: 'playbook', playbook_key: 'winback_1', name: `C${i}`, status: 'completed', created_at: daysAgo(i + 1) }));
    expect((await listPlaybookViews(NOW_SEND)).find((v) => v.key === 'winback_1')!.last_runs).toHaveLength(5);
  });
});

describe('patchPlaybook', () => {
  it('changes the mode and stamps who did it', async () => {
    const r = await patchPlaybook('winback_1', { mode: 'auto' }, 'owner-1', NOW_SEND);
    expect(r).toMatchObject({ ok: true, playbook: { key: 'winback_1', mode: 'auto' } });
    expect(pb('winback_1')).toMatchObject({ mode: 'auto', updated_by: 'owner-1' });
  });

  it('merges a partial params patch over the stored params', async () => {
    const r = await patchPlaybook('winback_1', { params: { max_days: 60 } }, 'owner-1');
    expect(r.ok).toBe(true);
    expect(pb('winback_1').params).toEqual({ gap_multiplier: 2.5, min_days: 14, max_days: 60, default_days: 30 });
  });

  it('checks the cross-field rule on the MERGED params: a patch carrying only min_days can still break max_days', async () => {
    const r = await patchPlaybook('winback_1', { params: { min_days: 50 } }, 'owner-1');
    expect(r).toEqual({ ok: false, error: 'The shortest lapse threshold cannot be longer than the longest.' });
    expect(pb('winback_1').params).toMatchObject({ min_days: 14 });

    const r3 = await patchPlaybook('winback_3', { params: { max_days: 50 } }, 'owner-1');
    expect(r3).toMatchObject({ ok: false, error: expect.stringContaining('"lost after"') });
  });

  it('replaces the offer and the template as a whole, and edits the prior', async () => {
    const template = { name: 'my_template', lang: 'en_US', vars: ['first_name', 'code'] as const, url_button: false, body_preview: 'Hi {{1}} {{2}}' };
    await patchPlaybook('winback_1', { offer: { type: 'flat', amount_inr: 40, min_order_inr: 120, validity_days: 5 }, template: { ...template, vars: [...template.vars] }, prior_conversion_pct: 9.5 }, 'owner-1');
    expect(pb('winback_1')).toMatchObject({
      offer: { type: 'flat', amount_inr: 40, min_order_inr: 120, validity_days: 5 },
      template: { name: 'my_template', lang: 'en_US', url_button: false },
      prior_conversion_pct: 9.5,
    });
  });

  it('does not touch anything the patch leaves out, or any other playbook', async () => {
    const before = JSON.stringify(pb('winback_2'));
    await patchPlaybook('winback_1', { mode: 'auto' }, 'owner-1');
    expect(JSON.stringify(pb('winback_2'))).toBe(before);
    expect(pb('winback_1')).toMatchObject({ offer: { type: 'percent', percent: 10 }, prior_conversion_pct: 12 });
  });

  it('never resets the learning counters', async () => {
    pb('winback_1').observed_treated = 80;
    pb('winback_1').observed_conversions = 9;
    await patchPlaybook('winback_1', { mode: 'off' }, 'owner-1');
    expect(pb('winback_1')).toMatchObject({ observed_treated: 80, observed_conversions: 9 });
  });

  it('creates the row if it was never seeded (the migration seeds five, but a deleted one must not wedge the page)', async () => {
    db().tables.marketing_playbooks = db().tables.marketing_playbooks.filter((r: Row) => r.key !== 'points_balance');
    const r = await patchPlaybook('points_balance', { mode: 'review' }, 'owner-1');
    expect(r).toMatchObject({ ok: true, playbook: { key: 'points_balance', mode: 'review', priority: 5 } });
    expect(pb('points_balance')).toMatchObject({ mode: 'review', params: { min_points: 50, min_days_since_order: 10, cooldown_days: 21 } });
  });
});
