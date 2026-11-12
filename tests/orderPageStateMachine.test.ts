import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ORDER_PAGE_ACTIONS,
  ORDER_PAGE_ACTION_TRANSITIONS,
  PAYMENT_POLL_FAST_ATTEMPTS,
  PAYMENT_POLL_FAST_MS,
  PAYMENT_POLL_SLOW_ATTEMPTS,
  PAYMENT_POLL_SLOW_MS,
  actionsLocked,
  canActionTransition,
  nextAction,
  paymentPollDelay,
  paymentWaitingHint,
  type OrderPageAction,
} from '@/app/order/[id]/orderPageState';
import { latestOnly, newestApplied } from '@/lib/hooks/requestSequence';

// The customer order page (app/order/[id]/page.tsx): one action at a time, the
// payment poll's schedule, and refetches that can't overwrite newer answers.

describe('order page actions', () => {
  const allowed: [OrderPageAction, OrderPageAction][] = [
    ['idle', 'retrying'],
    ['retrying', 'paying'],
    ['retrying', 'idle'],
    ['paying', 'idle'],
    ['idle', 'switching'],
    ['switching', 'idle'],
    ['idle', 'cancelling'],
    ['cancelling', 'idle'],
  ];

  it('the table is exactly the documented picture', () => {
    expect(ORDER_PAGE_ACTION_TRANSITIONS.map((t) => [t.from, t.to])).toEqual(allowed);
  });

  it('every other pair is refused', () => {
    for (const from of ORDER_PAGE_ACTIONS) {
      for (const to of ORDER_PAGE_ACTIONS) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        expect(canActionTransition(from, to).ok, `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it('Retry and "Switch to pay at counter" are mutually exclusive, including while the window is up', () => {
    for (const busy of ['retrying', 'paying', 'switching', 'cancelling'] as const) {
      expect(actionsLocked(busy)).toBe(true);
      for (const start of ['retrying', 'switching', 'cancelling'] as const) {
        const check = canActionTransition(busy, start);
        expect(check.ok, `${busy} → ${start}`).toBe(false);
        expect(check.code).toBe('action_in_flight');
        expect(nextAction(busy, start)).toBe(busy);
      }
    }
    expect(actionsLocked('idle')).toBe(false);
  });

  it('a retry holds the lock from the request through the open window', () => {
    let a: OrderPageAction = 'idle';
    a = nextAction(a, 'retrying');
    a = nextAction(a, 'paying');
    expect(a).toBe('paying');
    expect(actionsLocked(a)).toBe(true);
    expect(nextAction(a, 'idle')).toBe('idle');
  });
});

describe('payment poll schedule', () => {
  it('fast for ~2 minutes, then slow, then stops', () => {
    expect(paymentPollDelay(0)).toBe(PAYMENT_POLL_FAST_MS);
    expect(paymentPollDelay(PAYMENT_POLL_FAST_ATTEMPTS - 1)).toBe(PAYMENT_POLL_FAST_MS);
    // It used to stop here for good while the page said "updates automatically".
    expect(paymentPollDelay(PAYMENT_POLL_FAST_ATTEMPTS)).toBe(PAYMENT_POLL_SLOW_MS);
    expect(paymentPollDelay(PAYMENT_POLL_FAST_ATTEMPTS + PAYMENT_POLL_SLOW_ATTEMPTS - 1)).toBe(PAYMENT_POLL_SLOW_MS);
    expect(paymentPollDelay(PAYMENT_POLL_FAST_ATTEMPTS + PAYMENT_POLL_SLOW_ATTEMPTS)).toBeNull();
  });

  it('covers about half an hour in all', () => {
    let total = 0;
    for (let i = 0; ; i++) {
      const d = paymentPollDelay(i);
      if (d === null) break;
      total += d;
    }
    expect(total).toBeGreaterThanOrEqual(29 * 60_000);
    expect(total).toBeLessThanOrEqual(31 * 60_000);
  });

  it('the page only promises automatic updates while the poll runs', () => {
    expect(paymentWaitingHint(false)).toMatch(/updates automatically/);
    expect(paymentWaitingHint(true)).toMatch(/refresh this page/);
    expect(paymentWaitingHint(true)).not.toMatch(/automatically/);
  });

  it('the page uses the hint rather than hard-coding the promise', () => {
    const page = readFileSync('app/order/[id]/page.tsx', 'utf8');
    expect(page).toContain('paymentWaitingHint(pollStopped)');
    expect(page).not.toContain('this updates automatically, usually within a few seconds');
    expect(page).not.toContain('PAYMENT_POLL_MAX_ATTEMPTS');
  });
});

describe('request ordering (lib/hooks/requestSequence.ts)', () => {
  it('newestApplied: a slow older answer never overwrites a newer one already shown', () => {
    const seq = newestApplied();
    const poll = seq.begin(); // the payment poll's refetch, read before the payment landed
    const realtime = seq.begin(); // the realtime ping after it landed
    expect(seq.accept(realtime)).toBe(true); // "Paid" shown
    expect(seq.accept(poll)).toBe(false); // the stale "Waiting on payment" is dropped
  });

  it('newestApplied: answers in order all apply, and a stream of refreshes cannot starve the screen', () => {
    const seq = newestApplied();
    const a = seq.begin();
    const b = seq.begin();
    expect(seq.accept(a)).toBe(true);
    const c = seq.begin();
    expect(seq.accept(b)).toBe(true);
    expect(seq.accept(c)).toBe(true);
  });

  it('latestOnly: only the last request started may update the screen', () => {
    const seq = latestOnly();
    const active = seq.begin(); // "Active" tab
    const past = seq.begin(); // the customer taps "Past"
    expect(seq.isCurrent(active)).toBe(false); // a late Active answer must not switch the tab back
    expect(seq.isCurrent(past)).toBe(true);
    seq.invalidate();
    expect(seq.isCurrent(past)).toBe(false);
  });

  it('order history and the Suggest wizard drop superseded answers', () => {
    const history = readFileSync('app/account/orders/page.tsx', 'utf8');
    expect(history).toContain('if (!loads.current.isCurrent(id)) return;');
    expect(history).toContain('if (loads.current.isCurrent(id)) setLoading(false);');
    const wizard = readFileSync('components/suggest/SuggestWizard.tsx', 'utf8');
    expect(wizard).toContain('const run = runs.current.begin();');
    expect(wizard).toContain('runAbort.current?.abort();');
    expect(wizard).toContain('if (!runs.current.isCurrent(run)) return;\n        setResponse(result);');
  });
});
