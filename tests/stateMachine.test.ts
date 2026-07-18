import { describe, expect, it } from 'vitest';
import {
  ACTIVE_LANES,
  canTransition,
  findTransition,
  isTerminal,
  PRIMARY_NEXT,
  TERMINAL_STATUSES,
} from '@/lib/orders/stateMachine';
import type { OrderStatus } from '@/lib/types';

// F1 order state machine (docs/PHASE-1-SPEC.md §F1). These are the repo's first
// automated tests and the source of truth for the transition matrix.

describe('canTransition — legal transitions', () => {
  it('allows staff received → accepted', () => {
    expect(canTransition('received', 'accepted', 'staff').ok).toBe(true);
  });

  it('allows owner to do anything staff can (received → accepted)', () => {
    expect(canTransition('received', 'accepted', 'owner').ok).toBe(true);
  });

  it('walks the happy path accepted → preparing → ready → completed', () => {
    expect(canTransition('accepted', 'preparing', 'staff').ok).toBe(true);
    expect(canTransition('preparing', 'ready', 'staff').ok).toBe(true);
    expect(canTransition('ready', 'completed', 'staff').ok).toBe(true);
  });

  it('lets a customer cancel a not-yet-accepted order (with reason)', () => {
    expect(canTransition('received', 'cancelled', 'customer', 'changed my mind').ok).toBe(true);
  });
});

describe('canTransition — rejected transitions', () => {
  it('rejects an illegal jump (completed → preparing) as not_allowed', () => {
    const res = canTransition('completed', 'preparing', 'staff');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not_allowed');
  });

  it('rejects backward flow (ready → received)', () => {
    expect(canTransition('ready', 'received', 'staff').ok).toBe(false);
  });

  it('forbids a customer from accepting an order (forbidden_actor)', () => {
    const res = canTransition('received', 'accepted', 'customer');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('forbidden_actor');
  });

  it('requires a reason to reject (reason_required)', () => {
    const noReason = canTransition('received', 'rejected', 'staff');
    expect(noReason.ok).toBe(false);
    expect(noReason.code).toBe('reason_required');
    expect(canTransition('received', 'rejected', 'staff', 'out of stock').ok).toBe(true);
  });

  it('does not let a plain staff member cancel a preparing order (owner override only)', () => {
    expect(canTransition('preparing', 'cancelled', 'staff', 'x').ok).toBe(false);
    expect(canTransition('preparing', 'cancelled', 'owner', 'x').ok).toBe(true);
  });
});

describe('terminal states', () => {
  it('marks completed/rejected/cancelled terminal and nothing leaves them', () => {
    for (const t of TERMINAL_STATUSES) {
      expect(isTerminal(t)).toBe(true);
    }
    const reachableFromTerminal = (['completed', 'rejected', 'cancelled'] as OrderStatus[]).flatMap(
      (from) =>
        (['received', 'accepted', 'preparing', 'ready'] as OrderStatus[]).filter(
          (to) => findTransition(from, to) !== undefined,
        ),
    );
    expect(reachableFromTerminal).toHaveLength(0);
  });
});

describe('UI helpers', () => {
  it('exposes the four active lanes in flow order', () => {
    expect(ACTIVE_LANES).toEqual(['received', 'accepted', 'preparing', 'ready']);
  });

  it('primary-next matches the happy path', () => {
    expect(PRIMARY_NEXT.received).toBe('accepted');
    expect(PRIMARY_NEXT.ready).toBe('completed');
  });
});
