import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchPairingEvents, parsePairingLines, writePairingAttribution } from '@/lib/suggest/attribution';
import { PAIRING_LIMITS } from '@/lib/suggest/types';

// Coffey checkout pairings (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.3): the order
// route's `pairing_lines` → 'ordered' pairing_events rows. The parser is lenient
// (an analytics field must never fail a checkout) and the writer is best-effort.

const ORDER_ID = '99999999-9999-4999-8999-999999999999';
const USER_ID = '88888888-8888-4888-8888-888888888888';
const AMERICANO = '11111111-1111-4111-8111-111111111111';
const BROWNIE = '22222222-2222-4222-8222-222222222222';
const SANDWICH = '33333333-3333-4333-8333-333333333333';
const LATTE = '44444444-4444-4444-8444-444444444444';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

describe('parsePairingLines', () => {
  it('keeps valid { menu_item_id, anchor_item_id } entries', () => {
    expect(
      parsePairingLines([
        { menu_item_id: BROWNIE, anchor_item_id: AMERICANO },
        { menu_item_id: SANDWICH, anchor_item_id: AMERICANO },
      ]),
    ).toEqual([
      { menu_item_id: BROWNIE, anchor_item_id: AMERICANO },
      { menu_item_id: SANDWICH, anchor_item_id: AMERICANO },
    ]);
  });

  it('is [] for anything that is not an array — and never throws', () => {
    for (const raw of [undefined, null, 'x', 5, true, {}, { menu_item_id: BROWNIE, anchor_item_id: AMERICANO }]) {
      expect(parsePairingLines(raw), String(raw)).toEqual([]);
    }
  });

  it('drops malformed entries and keeps the good ones around them', () => {
    expect(
      parsePairingLines([
        null,
        7,
        'x',
        [],
        {},
        { menu_item_id: BROWNIE },
        { anchor_item_id: AMERICANO },
        { menu_item_id: 'not-a-uuid', anchor_item_id: AMERICANO },
        { menu_item_id: BROWNIE, anchor_item_id: 'not-a-uuid' },
        { menu_item_id: 5, anchor_item_id: 6 },
        { menu_item_id: { toString: () => BROWNIE }, anchor_item_id: AMERICANO },
        { menu_item_id: SANDWICH, anchor_item_id: AMERICANO },
      ]),
    ).toEqual([{ menu_item_id: SANDWICH, anchor_item_id: AMERICANO }]);
  });

  it('keeps one entry per item — the first anchor wins — so money is never counted twice', () => {
    expect(
      parsePairingLines([
        { menu_item_id: BROWNIE, anchor_item_id: AMERICANO },
        { menu_item_id: BROWNIE, anchor_item_id: LATTE },
        { menu_item_id: BROWNIE, anchor_item_id: AMERICANO },
      ]),
    ).toEqual([{ menu_item_id: BROWNIE, anchor_item_id: AMERICANO }]);
  });

  it('drops an item "paired" with itself', () => {
    expect(parsePairingLines([{ menu_item_id: BROWNIE, anchor_item_id: BROWNIE }])).toEqual([]);
  });

  it('lower-cases ids so they match the order lines', () => {
    expect(parsePairingLines([{ menu_item_id: BROWNIE.toUpperCase(), anchor_item_id: AMERICANO.toUpperCase() }])).toEqual([
      { menu_item_id: BROWNIE, anchor_item_id: AMERICANO },
    ]);
  });

  it('caps at orderLinesMax (5) by default, and at a caller-supplied max', () => {
    expect(PAIRING_LIMITS.orderLinesMax).toBe(5);
    const raw = Array.from({ length: 9 }, (_, i) => ({ menu_item_id: uuid(i + 1), anchor_item_id: AMERICANO }));
    const parsed = parsePairingLines(raw);
    expect(parsed).toHaveLength(5);
    expect(parsed.map((l) => l.menu_item_id)).toEqual([1, 2, 3, 4, 5].map(uuid));
    expect(parsePairingLines(raw, 2)).toHaveLength(2);
    expect(parsePairingLines(raw, 0)).toEqual([]);
  });

  it('counts only the lines it KEEPS against the cap, so junk first cannot crowd out good entries', () => {
    const raw = [
      ...Array.from({ length: 10 }, () => ({ menu_item_id: 'bad', anchor_item_id: 'bad' })),
      { menu_item_id: BROWNIE, anchor_item_id: AMERICANO },
    ];
    expect(parsePairingLines(raw)).toEqual([{ menu_item_id: BROWNIE, anchor_item_id: AMERICANO }]);
  });
});

describe('matchPairingEvents', () => {
  const pairing = (menu_item_id: string, anchor_item_id = AMERICANO) => ({ menu_item_id, anchor_item_id });

  it('writes one ordered event per pairing line whose item is in the order', () => {
    const events = matchPairingEvents({
      orderId: ORDER_ID,
      userId: USER_ID,
      lines: [
        { menu_item_id: AMERICANO, line_total_inr: 80 },
        { menu_item_id: BROWNIE, line_total_inr: 120 },
      ],
      pairingLines: [pairing(BROWNIE)],
    });
    expect(events).toEqual([
      {
        user_id: USER_ID,
        event: 'ordered',
        menu_item_id: BROWNIE,
        anchor_item_id: AMERICANO,
        order_id: ORDER_ID,
        value_inr: 120,
      },
    ]);
  });

  it('skips a pairing line for an item that is not in the order', () => {
    const events = matchPairingEvents({
      orderId: ORDER_ID,
      userId: null,
      lines: [{ menu_item_id: AMERICANO, line_total_inr: 80 }],
      pairingLines: [pairing(BROWNIE), pairing(SANDWICH)],
    });
    expect(events).toEqual([]);
  });

  it('value_inr is the summed line totals of that item in the order', () => {
    const events = matchPairingEvents({
      orderId: ORDER_ID,
      userId: null,
      lines: [
        { menu_item_id: BROWNIE, line_total_inr: 120 }, // plain
        { menu_item_id: AMERICANO, line_total_inr: 80 },
        { menu_item_id: BROWNIE, line_total_inr: 280 }, // with an add-on, qty 2
        { menu_item_id: SANDWICH, line_total_inr: 150 },
      ],
      pairingLines: [pairing(BROWNIE), pairing(SANDWICH, LATTE)],
    });
    expect(events.map((e) => [e.menu_item_id, e.anchor_item_id, e.value_inr])).toEqual([
      [BROWNIE, AMERICANO, 400],
      [SANDWICH, LATTE, 150],
    ]);
  });

  it('ignores order lines with no menu item (free-text lines)', () => {
    const events = matchPairingEvents({
      orderId: ORDER_ID,
      userId: null,
      lines: [{ menu_item_id: null, line_total_inr: 999 }, { menu_item_id: BROWNIE, line_total_inr: 120 }],
      pairingLines: [pairing(BROWNIE)],
    });
    expect(events.map((e) => e.value_inr)).toEqual([120]);
  });

  it('carries a null user_id for a guest order', () => {
    const events = matchPairingEvents({
      orderId: ORDER_ID,
      userId: null,
      lines: [{ menu_item_id: BROWNIE, line_total_inr: 120 }],
      pairingLines: [pairing(BROWNIE)],
    });
    expect(events[0].user_id).toBeNull();
  });
});

describe('writePairingAttribution', () => {
  let inserts: { table: string; rows: Record<string, unknown>[] }[];
  let insertResult: { error: unknown } | (() => never);
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const admin = () =>
    ({
      from: (table: string) => ({
        insert: (rows: Record<string, unknown>[]) => {
          inserts.push({ table, rows });
          if (typeof insertResult === 'function') return insertResult();
          return Promise.resolve(insertResult);
        },
      }),
    }) as unknown as Parameters<typeof writePairingAttribution>[0];

  beforeEach(() => {
    inserts = [];
    insertResult = { error: null };
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  const lines = [
    { menu_item_id: AMERICANO, line_total_inr: 80 },
    { menu_item_id: BROWNIE, line_total_inr: 120 },
    { menu_item_id: BROWNIE, line_total_inr: 240 },
  ];

  it('inserts one ordered pairing_events row per pairing line that is on the order', async () => {
    await writePairingAttribution(admin(), {
      orderId: ORDER_ID,
      userId: USER_ID,
      lines,
      pairingLines: [
        { menu_item_id: BROWNIE, anchor_item_id: AMERICANO },
        { menu_item_id: SANDWICH, anchor_item_id: AMERICANO }, // not on the order
      ],
    });
    expect(inserts).toEqual([
      {
        table: 'pairing_events',
        rows: [
          {
            user_id: USER_ID,
            event: 'ordered',
            menu_item_id: BROWNIE,
            anchor_item_id: AMERICANO,
            order_id: ORDER_ID,
            value_inr: 360,
          },
        ],
      },
    ]);
  });

  it('writes nothing — not even a query — when there are no pairing lines, or none match', async () => {
    await writePairingAttribution(admin(), { orderId: ORDER_ID, userId: null, lines, pairingLines: [] });
    await writePairingAttribution(admin(), {
      orderId: ORDER_ID,
      userId: null,
      lines,
      pairingLines: [{ menu_item_id: SANDWICH, anchor_item_id: AMERICANO }],
    });
    expect(inserts).toEqual([]);
  });

  it('never throws when the insert errors (the table may not exist yet) — it logs', async () => {
    insertResult = { error: { message: 'relation "pairing_events" does not exist' } };
    await expect(
      writePairingAttribution(admin(), {
        orderId: ORDER_ID,
        userId: null,
        lines,
        pairingLines: [{ menu_item_id: BROWNIE, anchor_item_id: AMERICANO }],
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('an anchor that is not a menu item (FK 23503) keeps the sale: one retry with the anchor cleared', async () => {
    let calls = 0;
    insertResult = { error: null };
    const fkOnce = {
      from: (table: string) => ({
        insert: (rows: Record<string, unknown>[]) => {
          inserts.push({ table, rows });
          calls += 1;
          return Promise.resolve(calls === 1 ? { error: { code: '23503', message: 'violates foreign key' } } : { error: null });
        },
      }),
    } as unknown as Parameters<typeof writePairingAttribution>[0];

    await writePairingAttribution(fkOnce, {
      orderId: ORDER_ID,
      userId: USER_ID,
      lines,
      pairingLines: [{ menu_item_id: BROWNIE, anchor_item_id: LATTE }],
    });
    expect(inserts).toHaveLength(2);
    expect(inserts[1].rows).toEqual([
      { user_id: USER_ID, event: 'ordered', menu_item_id: BROWNIE, anchor_item_id: null, order_id: ORDER_ID, value_inr: 360 },
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not retry on any other insert error', async () => {
    insertResult = { error: { code: '42P01', message: 'relation "pairing_events" does not exist' } };
    await writePairingAttribution(admin(), {
      orderId: ORDER_ID,
      userId: null,
      lines,
      pairingLines: [{ menu_item_id: BROWNIE, anchor_item_id: AMERICANO }],
    });
    expect(inserts).toHaveLength(1);
  });

  it('never throws when the insert itself throws', async () => {
    insertResult = () => {
      throw new Error('connection reset');
    };
    await expect(
      writePairingAttribution(admin(), {
        orderId: ORDER_ID,
        userId: null,
        lines,
        pairingLines: [{ menu_item_id: BROWNIE, anchor_item_id: AMERICANO }],
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
