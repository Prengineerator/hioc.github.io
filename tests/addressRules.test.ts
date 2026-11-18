import { describe, expect, it } from 'vitest';
import {
  ADDRESS_LIMIT_MESSAGE,
  MAX_SAVED_ADDRESSES,
  canAddAddress,
  nextDefaultAfterDelete,
  pincodeStatePatch,
  pickPreselectedAddress,
  sortAddresses,
} from '@/lib/account/addressRules';

type A = { id: string; is_default: boolean; last_used_at: string | null; created_at: string };
const a = (id: string, o: Partial<A> = {}): A => ({
  id,
  is_default: false,
  last_used_at: null,
  created_at: '2026-01-01T00:00:00Z',
  ...o,
});

describe('canAddAddress', () => {
  it('allows the 10th and refuses the 11th', () => {
    expect(MAX_SAVED_ADDRESSES).toBe(10);
    expect(canAddAddress(0)).toBe(true);
    expect(canAddAddress(9)).toBe(true);
    expect(canAddAddress(10)).toBe(false);
    expect(canAddAddress(11)).toBe(false);
  });
  it('carries the exact message', () => {
    expect(ADDRESS_LIMIT_MESSAGE).toBe('You can save up to 10 addresses. Delete one to add another.');
  });
});

describe('sortAddresses', () => {
  it('puts the default first, then recent use (never-used last), then newest created', () => {
    const list = [
      a('never-old', { created_at: '2026-01-01T00:00:00Z' }),
      a('never-new', { created_at: '2026-03-01T00:00:00Z' }),
      a('used-old', { last_used_at: '2026-02-01T00:00:00Z' }),
      a('used-new', { last_used_at: '2026-04-01T00:00:00Z' }),
      a('def', { is_default: true, last_used_at: '2025-01-01T00:00:00Z' }),
    ];
    expect(sortAddresses(list).map((x) => x.id)).toEqual(['def', 'used-new', 'used-old', 'never-new', 'never-old']);
  });
  it('does not mutate its input', () => {
    const list = [a('x'), a('y', { is_default: true })];
    sortAddresses(list);
    expect(list.map((x) => x.id)).toEqual(['x', 'y']);
  });
});

describe('pickPreselectedAddress', () => {
  it('is null for an empty book', () => expect(pickPreselectedAddress([])).toBeNull());
  it('prefers the default', () => {
    const list = [a('recent', { last_used_at: '2026-05-01T00:00:00Z' }), a('def', { is_default: true })];
    expect(pickPreselectedAddress(list)?.id).toBe('def');
  });
  it('else the most recently used', () => {
    const list = [a('old', { last_used_at: '2026-01-01T00:00:00Z' }), a('recent', { last_used_at: '2026-05-01T00:00:00Z' })];
    expect(pickPreselectedAddress(list)?.id).toBe('recent');
  });
  it('else the newest', () => {
    const list = [a('old'), a('new', { created_at: '2026-06-01T00:00:00Z' })];
    expect(pickPreselectedAddress(list)?.id).toBe('new');
  });
});

describe('nextDefaultAfterDelete', () => {
  it('promotes the most recently used when the default goes', () => {
    const list = [a('def', { is_default: true }), a('old', { last_used_at: '2026-01-01T00:00:00Z' }), a('recent', { last_used_at: '2026-05-01T00:00:00Z' })];
    expect(nextDefaultAfterDelete(list, 'def')).toBe('recent');
  });
  it('is null when a non-default goes, the last one goes, or the id is unknown', () => {
    const list = [a('def', { is_default: true }), a('other')];
    expect(nextDefaultAfterDelete(list, 'other')).toBeNull();
    expect(nextDefaultAfterDelete([a('only', { is_default: true })], 'only')).toBeNull();
    expect(nextDefaultAfterDelete(list, 'nope')).toBeNull();
  });
});

describe('pincodeStatePatch', () => {
  it('fills an empty state', () => {
    expect(pincodeStatePatch('', '560001', null)).toBe('Karnataka');
    expect(pincodeStatePatch(undefined, '560001', null)).toBe('Karnataka');
  });

  it('replaces a state it filled itself', () => {
    expect(pincodeStatePatch('Karnataka', '600001', 'Karnataka')).toBe('Tamil Nadu');
  });

  it('never replaces a hand-picked or prefilled state', () => {
    // Nothing auto-filled yet: the state came from the customer or a saved address.
    expect(pincodeStatePatch('Kerala', '560001', null)).toBeNull();
    // Something was auto-filled earlier, but the current state is a different one.
    expect(pincodeStatePatch('Kerala', '600001', 'Karnataka')).toBeNull();
  });

  it('changes nothing for an invalid or unknown pincode', () => {
    expect(pincodeStatePatch('', '5600', null)).toBeNull();
    expect(pincodeStatePatch('', 'abcdef', null)).toBeNull();
    expect(pincodeStatePatch('', '000000', null)).toBeNull();
    expect(pincodeStatePatch('Karnataka', '396001', 'Karnataka')).toBeNull(); // shared prefix: no guess
  });
});
