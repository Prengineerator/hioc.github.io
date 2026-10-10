import { describe, expect, it } from 'vitest';
import {
  PAIRING_ANON_ID_MAX_CHARS,
  validatePairingEventsRequest,
  validatePairingRequest,
} from '@/lib/suggest/pairingsValidate';
import { CLIENT_PAIRING_EVENTS, PAIRING_LIMITS } from '@/lib/suggest/types';

// Coffey checkout pairings (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.2, §4.3): the
// pure body validators behind POST /api/suggest/pairings and .../events.

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

describe('validatePairingRequest', () => {
  it('accepts distinct uuids and keeps their order', () => {
    expect(validatePairingRequest({ itemIds: [B, A] })).toEqual({ itemIds: [B, A] });
  });

  it('de-duplicates, first-seen order kept', () => {
    expect(validatePairingRequest({ itemIds: [A, B, A, C, B] })).toEqual({ itemIds: [A, B, C] });
  });

  it('lower-cases ids, so the same id in two cases is one id', () => {
    expect(validatePairingRequest({ itemIds: [A.toUpperCase(), A] })).toEqual({ itemIds: [A] });
  });

  it('accepts an empty list (nothing to pair)', () => {
    expect(validatePairingRequest({ itemIds: [] })).toEqual({ itemIds: [] });
  });

  it('allows exactly cartItemsMax distinct ids, and rejects one more', () => {
    const max = PAIRING_LIMITS.cartItemsMax;
    const ok = Array.from({ length: max }, (_, i) => uuid(i + 1));
    expect(validatePairingRequest({ itemIds: ok })).toEqual({ itemIds: ok });
    expect(typeof validatePairingRequest({ itemIds: [...ok, uuid(max + 1)] })).toBe('string');
  });

  it('counts DISTINCT ids against the cap, so a cart of repeats is fine', () => {
    const repeats = Array.from({ length: PAIRING_LIMITS.cartItemsMax + 5 }, () => A);
    expect(validatePairingRequest({ itemIds: repeats })).toEqual({ itemIds: [A] });
  });

  it('returns an error string for anything malformed', () => {
    for (const body of [
      null,
      undefined,
      'itemIds',
      42,
      [],
      {},
      { itemIds: null },
      { itemIds: A },
      { itemIds: { 0: A } },
      { itemIds: ['not-a-uuid'] },
      { itemIds: [A, 'not-a-uuid'] },
      { itemIds: [A, 7] },
      { itemIds: [A, null] },
      { itemIds: [`${A} `] },
    ]) {
      expect(typeof validatePairingRequest(body), JSON.stringify(body)).toBe('string');
    }
  });
});

describe('validatePairingEventsRequest', () => {
  const shown = { event: 'shown', menuItemId: A, anchorItemId: B };
  const added = { event: 'added', menuItemId: C, anchorItemId: B };

  it('accepts a batch of whitelisted events', () => {
    expect(validatePairingEventsRequest({ anonId: 'anon-1', events: [shown, added] })).toEqual({
      anonId: 'anon-1',
      events: [shown, added],
    });
  });

  it('anonId is optional (absent, null and empty all mean none)', () => {
    expect(validatePairingEventsRequest({ events: [shown] })).toEqual({ anonId: null, events: [shown] });
    expect(validatePairingEventsRequest({ anonId: null, events: [shown] })).toEqual({ anonId: null, events: [shown] });
    expect(validatePairingEventsRequest({ anonId: '', events: [shown] })).toEqual({ anonId: null, events: [shown] });
  });

  it('anonId may be up to 64 characters, not 65, and must be a string', () => {
    const max = 'a'.repeat(PAIRING_ANON_ID_MAX_CHARS);
    expect(PAIRING_ANON_ID_MAX_CHARS).toBe(64);
    expect(validatePairingEventsRequest({ anonId: max, events: [shown] })).toEqual({ anonId: max, events: [shown] });
    expect(typeof validatePairingEventsRequest({ anonId: `${max}a`, events: [shown] })).toBe('string');
    expect(typeof validatePairingEventsRequest({ anonId: 5, events: [shown] })).toBe('string');
    expect(typeof validatePairingEventsRequest({ anonId: { id: 'x' }, events: [shown] })).toBe('string');
  });

  it('only the client whitelist is accepted: "ordered" is server-written', () => {
    expect([...CLIENT_PAIRING_EVENTS]).toEqual(['shown', 'added']);
    for (const event of ['ordered', 'bogus', '', 'SHOWN', 7, null, undefined]) {
      const res = validatePairingEventsRequest({ events: [{ ...shown, event }] });
      expect(typeof res, String(event)).toBe('string');
    }
  });

  it('both ids must be uuids', () => {
    expect(typeof validatePairingEventsRequest({ events: [{ ...shown, menuItemId: 'nope' }] })).toBe('string');
    expect(typeof validatePairingEventsRequest({ events: [{ ...shown, anchorItemId: 'nope' }] })).toBe('string');
    expect(typeof validatePairingEventsRequest({ events: [{ event: 'shown', menuItemId: A }] })).toBe('string');
    expect(typeof validatePairingEventsRequest({ events: [{ event: 'shown', anchorItemId: A }] })).toBe('string');
  });

  it('allows at most eventsPerRequest events, and at least one', () => {
    const max = PAIRING_LIMITS.eventsPerRequest;
    const events = Array.from({ length: max }, () => shown);
    expect(validatePairingEventsRequest({ events })).toEqual({ anonId: null, events });
    expect(typeof validatePairingEventsRequest({ events: [...events, shown] })).toBe('string');
    expect(typeof validatePairingEventsRequest({ events: [] })).toBe('string');
  });

  it('returns an error string for a malformed body', () => {
    for (const body of [
      null,
      undefined,
      'x',
      [],
      {},
      { events: null },
      { events: shown },
      { events: ['shown'] },
      { events: [null] },
      { events: [[]] },
    ]) {
      expect(typeof validatePairingEventsRequest(body), JSON.stringify(body)).toBe('string');
    }
  });

  it('never reads a user id from the body', () => {
    const res = validatePairingEventsRequest({
      user_id: 'someone-else',
      userId: 'someone-else',
      events: [{ ...shown, user_id: 'someone-else', userId: 'someone-else' }],
    });
    expect(res).toEqual({ anonId: null, events: [shown] });
  });
});
