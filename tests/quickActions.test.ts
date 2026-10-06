import { describe, expect, it } from 'vitest';
import { canRemind, quickActionsFor, transitionExtra } from '@/lib/orders/quickActions';
import { TRANSITIONS, canTransition, type TransitionRule } from '@/lib/orders/stateMachine';
import type { OrderStatus, PaymentStatus } from '@/lib/types';

const at = (status: OrderStatus, payment_status: PaymentStatus = 'unpaid') => ({ status, payment_status });
const keys = (status: OrderStatus, pay: PaymentStatus = 'unpaid') =>
  quickActionsFor(at(status, pay)).menu.map((a) => a.key);

describe('quickActionsFor — corner action', () => {
  it('New → one-tap Accept with the default prep time', () => {
    const { corner } = quickActionsFor(at('received'));
    expect(corner).toMatchObject({ label: 'Accept', kind: 'transition', to: 'accepted', usesDefaultPrep: true });
  });

  it('Accepted → Start (preparing)', () => {
    expect(quickActionsFor(at('accepted')).corner).toMatchObject({ label: 'Start', kind: 'transition', to: 'preparing' });
  });

  it('Preparing → Ready', () => {
    expect(quickActionsFor(at('preparing')).corner).toMatchObject({ label: 'Ready', kind: 'transition', to: 'ready' });
  });

  it('Ready + paid → one-tap Complete', () => {
    expect(quickActionsFor(at('ready', 'paid')).corner).toMatchObject({
      label: 'Complete',
      kind: 'transition',
      to: 'completed',
    });
  });

  it('Ready + unpaid → Settle (never a Complete the server would refuse)', () => {
    const { corner } = quickActionsFor(at('ready', 'unpaid'));
    expect(corner).toMatchObject({ label: 'Settle', kind: 'settle' });
    expect(corner?.to).toBeUndefined();
  });

  it('Ready + a payment state that is not a counter settle → opens the detail', () => {
    for (const p of ['payment_pending', 'refunded', 'partially_refunded'] as const) {
      expect(quickActionsFor(at('ready', p)).corner).toMatchObject({ kind: 'open_detail' });
    }
  });

  it('has nothing for orders that are not on the board', () => {
    for (const s of ['placed', 'completed', 'rejected', 'cancelled'] as const) {
      expect(quickActionsFor(at(s, 'paid'))).toEqual({ corner: null, menu: [] });
    }
  });
});

describe('quickActionsFor — menu', () => {
  it('New: Reject… opens the detail on the reason step', () => {
    const { menu } = quickActionsFor(at('received'));
    expect(menu).toEqual([
      expect.objectContaining({ key: 'reject', kind: 'open_detail', detail: 'reject', tone: 'danger' }),
    ]);
  });

  it('Accepted: Cancel order, confirmed, staff may do it', () => {
    const { menu } = quickActionsFor(at('accepted'));
    expect(menu).toEqual([
      expect.objectContaining({ key: 'cancel', to: 'cancelled', confirm: expect.any(String), managerOnly: false }),
    ]);
  });

  it('Preparing: Cancel is labelled manager-only (the machine gives it to owner)', () => {
    const { menu } = quickActionsFor(at('preparing'));
    expect(menu).toEqual([
      expect.objectContaining({ key: 'cancel', label: 'Cancel order (manager)', managerOnly: true }),
    ]);
  });

  it('Ready: pickup-code check, then manager-only Cancel', () => {
    expect(keys('ready', 'paid')).toEqual(['verify', 'cancel']);
    expect(quickActionsFor(at('ready', 'paid')).menu[0]).toMatchObject({ kind: 'open_detail' });
  });

  it('never offers the corner action again in the menu', () => {
    for (const s of ['received', 'accepted', 'preparing', 'ready'] as const) {
      const { corner, menu } = quickActionsFor(at(s, 'paid'));
      expect(menu.some((a) => a.to && a.to === corner?.to)).toBe(false);
    }
  });

  it('every transition it offers is one the state machine allows staff/owner', () => {
    for (const s of ['received', 'accepted', 'preparing', 'ready'] as const) {
      for (const a of quickActionsFor(at(s, 'paid')).menu) {
        if (a.kind !== 'transition' || !a.to) continue;
        const check = canTransition(s, a.to, 'owner', 'reason');
        expect(check.ok, `${s} → ${a.to}`).toBe(true);
      }
    }
  });

  it('picks up an extra forward transition (e.g. skipping a step) from the table', () => {
    const skip: TransitionRule = { from: 'accepted', to: 'ready', actors: ['staff'], notify: 'ready' };
    const { menu } = quickActionsFor(at('accepted'), [...TRANSITIONS, skip]);
    expect(menu[0]).toMatchObject({ key: 'to-ready', label: 'Mark Ready', kind: 'transition', to: 'ready' });
  });

  it('ignores transitions staff cannot perform (customer/system only)', () => {
    const sysOnly: TransitionRule = { from: 'accepted', to: 'ready', actors: ['system'] };
    expect(quickActionsFor(at('accepted'), [...TRANSITIONS, sysOnly]).menu.map((a) => a.key)).toEqual(['cancel']);
  });
});

describe('transitionExtra', () => {
  const now = Date.parse('2026-09-29T10:00:00.000Z');

  it('Accept sends promised_ready_at = now + default prep', () => {
    const accept = quickActionsFor(at('received')).corner!;
    expect(transitionExtra(accept, 15, now)).toEqual({ promised_ready_at: '2026-09-29T10:15:00.000Z' });
  });

  it('Cancel sends the standard reason', () => {
    const cancel = quickActionsFor(at('accepted')).menu[0];
    expect(transitionExtra(cancel, 15, now)).toEqual({ reason: 'Cancelled by staff' });
  });

  it('a plain forward move sends nothing extra', () => {
    expect(transitionExtra(quickActionsFor(at('accepted')).corner!, 15, now)).toBeUndefined();
  });
});

describe('canRemind', () => {
  const base = { status: 'ready', customer_phone: '+919999999999', order_type: 'takeaway', table_id: null } as const;

  it('Ready pickup order with a phone', () => {
    expect(canRemind(base)).toBe(true);
  });
  it('not before Ready or after', () => {
    for (const s of ['received', 'accepted', 'preparing', 'completed'] as const) {
      expect(canRemind({ ...base, status: s })).toBe(false);
    }
  });
  it('needs a phone', () => {
    expect(canRemind({ ...base, customer_phone: '' })).toBe(false);
    expect(canRemind({ ...base, customer_phone: '  ' })).toBe(false);
  });
  it('not for dine-in at a table', () => {
    expect(canRemind({ ...base, order_type: 'dine_in', table_id: 'table-1' })).toBe(false);
  });
  it('a website dine-in (no table) is collected at the counter, so it can be reminded', () => {
    expect(canRemind({ ...base, order_type: 'dine_in' })).toBe(true);
  });
});
