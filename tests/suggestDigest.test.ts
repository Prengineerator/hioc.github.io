import { describe, expect, it, vi } from 'vitest';

// Phase 7 · SUG-12 — lib/suggest/digest.ts. Jev can't write prose, so the
// weekly digest is always the deterministic template: no model, no cost.

vi.mock('server-only', () => ({}));

import { generateWeeklyDigest } from '@/lib/suggest/digest';
import type { SuggestionStats } from '@/lib/suggest/types';

const STATS: SuggestionStats = {
  windowStart: '2026-09-21T00:00:00.000Z',
  sessions: 40,
  sessionsWithAdd: 20,
  sessionsCheckout: 12,
  sessionsOrdered: 10,
  attributedRevenueInr: 4200,
  suggestionAovInr: 420,
  webAovInr: 380,
  moodMix: [],
  topItems: [
    { menuItemId: 'm1', name: 'Iced Latte', suggested: 12, added: 5, ordered: 4, up: 2, down: 0 },
    { menuItemId: 'm2', name: 'Mocha', suggested: 6, added: 0, ordered: 0, up: 0, down: 1 },
  ],
  personalised: { sessions: 10, ordered: 3 },
  guest: { sessions: 30, ordered: 7 },
  llmShare: 0.75,
  fallbackReasons: [],
  latencyP50Ms: 300,
  latencyP90Ms: 600,
  costUsd: 0.01,
} as SuggestionStats;

describe('generateWeeklyDigest', () => {
  it('returns the template summary with no model and no cost', async () => {
    const digest = await generateWeeklyDigest(STATS);
    expect(digest.source).toBe('template');
    expect(digest.model).toBeNull();
    expect(digest.costUsdMicros).toBe(0);
  });

  it('reports the numbers it was given, crediting Jev for the answered share', async () => {
    const { summary } = await generateWeeklyDigest(STATS);
    expect(summary).toContain('40 suggestion session(s), 50% added something to cart, 25% went on to order');
    expect(summary).toContain('75% answered by Jev');
    expect(summary).toContain('"Iced Latte" was the most-suggested pick');
    expect(summary).toContain('1 suggested item(s) were never added');
    expect(summary.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
  });
});
