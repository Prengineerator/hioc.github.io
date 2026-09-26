import { describe, expect, it } from 'vitest';
import { kotItemsQuery, onlyKotItems, parseKotItemsParam } from '@/lib/print/kotAddition';
import { printFrameSrc, describePrintJob } from '@/lib/pos/printQueue';
import { printUrl } from '@/lib/staff/autoPrint';
import { statusAfterAdd } from '@/lib/orders/amend';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('added-items KOT', () => {
  it('parses the ids on the print URL, dropping anything that is not a line id', () => {
    expect(parseKotItemsParam(`${A},${B}`)).toEqual([A, B]);
    expect(parseKotItemsParam(`${A},not-an-id,${A}`)).toEqual([A]);
    expect(parseKotItemsParam('')).toBeNull();
    expect(parseKotItemsParam(undefined)).toBeNull();
    expect(parseKotItemsParam('junk')).toBeNull();
  });

  it('narrows the ticket to the added lines and flags it', () => {
    const order = { id: ORDER, items: [{ id: A }, { id: B }] };
    expect(onlyKotItems(order, [B])).toEqual({ id: ORDER, items: [{ id: B }], kot_addition: true });
  });

  it('prints the whole order when no ids are given or none match', () => {
    const order = { id: ORDER, items: [{ id: A }] };
    expect(onlyKotItems(order, null)).toBe(order);
    expect(onlyKotItems(order, [B])).toBe(order);
  });

  it('puts the ids on the KOT print URL only', () => {
    expect(kotItemsQuery([A, B])).toBe(`items=${A},${B}`);
    expect(printUrl(ORDER, 'kot', [A])).toBe(`/staff-print/${ORDER}/kot?items=${A}`);
    expect(printUrl(ORDER, 'receipt', [A])).toBe(`/staff-print/${ORDER}/receipt`);
    expect(printUrl(ORDER, 'kot')).toBe(`/staff-print/${ORDER}/kot`);
    expect(printFrameSrc(ORDER, 'kot', [A])).toBe(`/staff-print/${ORDER}/kot?items=${A}&auto=1`);
    expect(printFrameSrc(ORDER, 'kot')).toBe(`/staff-print/${ORDER}/kot?auto=1`);
  });

  it('names the job so a failed one says which ticket', () => {
    expect(describePrintJob({ type: 'kot', itemIds: [A] })).toBe('Added-items KOT');
    expect(describePrintJob({ type: 'kot' })).toBe('KOT');
  });
});

describe('statusAfterAdd', () => {
  it('sends a Ready order back to Preparing and leaves the rest', () => {
    expect(statusAfterAdd('ready')).toBe('preparing');
    expect(statusAfterAdd('preparing')).toBe('preparing');
    expect(statusAfterAdd('accepted')).toBe('accepted');
  });
});
