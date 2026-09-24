import { describe, expect, it } from 'vitest';
import { matchAttributionEvents, parseSuggestionSessionIds } from '@/lib/suggest/attribution';

// Phase 7 · SUG-9 — the pure attribution matcher + session-id parser.

const NOW = new Date('2026-06-10T12:00:00Z');
const ORDER_ID = '11111111-1111-4111-8111-111111111111';

describe('matchAttributionEvents', () => {
  it('writes one ordered event per line whose item was a pick or the usual', () => {
    const events = matchAttributionEvents({
      orderId: ORDER_ID,
      lines: [
        { menu_item_id: 'espresso', line_total_inr: 70 },
        { menu_item_id: 'cappuccino', line_total_inr: 130 },
        { menu_item_id: 'unrelated-item', line_total_inr: 200 },
      ],
      sessions: [
        {
          id: 'session-1',
          pick_ids: ['espresso'],
          usual_item_id: 'cappuccino',
          created_at: '2026-06-10T10:00:00Z',
        },
      ],
      now: NOW,
    });

    expect(events).toEqual([
      { session_id: 'session-1', event: 'ordered', menu_item_id: 'espresso', order_id: ORDER_ID, value_inr: 70 },
      { session_id: 'session-1', event: 'ordered', menu_item_id: 'cappuccino', order_id: ORDER_ID, value_inr: 130 },
    ]);
  });

  it('ignores a session older than maxAgeHours', () => {
    const events = matchAttributionEvents({
      orderId: ORDER_ID,
      lines: [{ menu_item_id: 'espresso', line_total_inr: 70 }],
      sessions: [
        { id: 'old-session', pick_ids: ['espresso'], usual_item_id: null, created_at: '2026-06-08T00:00:00Z' },
      ],
      now: NOW,
      maxAgeHours: 24,
    });
    expect(events).toEqual([]);
  });

  it('ignores a session with no matching pick/usual', () => {
    const events = matchAttributionEvents({
      orderId: ORDER_ID,
      lines: [{ menu_item_id: 'espresso', line_total_inr: 70 }],
      sessions: [
        { id: 'session-1', pick_ids: ['cappuccino'], usual_item_id: null, created_at: '2026-06-10T10:00:00Z' },
      ],
      now: NOW,
    });
    expect(events).toEqual([]);
  });

  it('skips a line with no menu_item_id', () => {
    const events = matchAttributionEvents({
      orderId: ORDER_ID,
      lines: [{ menu_item_id: null, line_total_inr: 70 }],
      sessions: [
        { id: 'session-1', pick_ids: ['espresso'], usual_item_id: null, created_at: '2026-06-10T10:00:00Z' },
      ],
      now: NOW,
    });
    expect(events).toEqual([]);
  });

  it('never fires an event for a future-dated session (clock skew guard)', () => {
    const events = matchAttributionEvents({
      orderId: ORDER_ID,
      lines: [{ menu_item_id: 'espresso', line_total_inr: 70 }],
      sessions: [
        { id: 'session-1', pick_ids: ['espresso'], usual_item_id: null, created_at: '2026-06-11T00:00:00Z' },
      ],
      now: NOW,
    });
    expect(events).toEqual([]);
  });
});

describe('parseSuggestionSessionIds', () => {
  it('keeps only distinct, valid uuids, capped at max', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const c = '33333333-3333-4333-8333-333333333333';
    expect(parseSuggestionSessionIds([a, a, b, c], 2)).toEqual([a, b]);
  });

  it('never throws on malformed input — returns an empty array', () => {
    expect(parseSuggestionSessionIds(undefined, 5)).toEqual([]);
    expect(parseSuggestionSessionIds(null, 5)).toEqual([]);
    expect(parseSuggestionSessionIds('not-an-array', 5)).toEqual([]);
    expect(parseSuggestionSessionIds([1, 2, 'not-a-uuid', {}], 5)).toEqual([]);
    expect(parseSuggestionSessionIds([123], 5)).toEqual([]);
  });
});
