import { describe, expect, it } from 'vitest';
import { renderNotification, templateVarsFor } from '@/lib/notifications/templates';
import type { Order } from '@/lib/types';

// Pure unit test for the RCT-1 6-var bill template. templates.ts is
// dependency-free (no server-only), so it renders directly with no mocks.

// A minimal order shaped like the e-bill callers pass (an OrderResponse: the
// order row plus `items`). Only the fields the bill template reads are set.
function billOrder(overrides: Partial<Order> & { items?: unknown[] } = {}): Order {
  return {
    id: 'order-abc',
    order_number: 1042,
    customer_name: 'Aisha Khan',
    customer_phone: '+919000000000',
    customer_email: 'aisha@example.com',
    subtotal_inr: 500,
    total_inr: 540,
    payment_method: 'upi',
    items: [{}, {}, {}], // 3 lines
    ...overrides,
  } as unknown as Order;
}

describe('bill template (RCT-1)', () => {
  it('templateVarsFor(order, "bill") returns exactly 6 vars in the specified order', () => {
    const vars = templateVarsFor(billOrder(), 'bill');
    expect(vars).toHaveLength(6);
    expect(vars[0]).toBe('Aisha'); // {{1}} customer first name
    expect(vars[1]).toBe('HIOC-001042'); // {{2}} order number (bare — template supplies '#')
    expect(vars[2]).toBe('540'); // {{3}} total ₹
    expect(vars[3]).toBe('3'); // {{4}} item count = order.items.length
    expect(vars[4]).toBe('UPI'); // {{5}} payment method
    expect(vars[5]).toMatch(/\/order\/order-abc\/receipt$/); // {{6}} receipt link
    // Meta rejects empty template params — every var must be non-empty.
    expect(vars.every((v) => v.length > 0)).toBe(true);
  });

  it('falls back to subtotal + "counter" when total / method are absent', () => {
    const vars = templateVarsFor(billOrder({ total_inr: null, payment_method: null }), 'bill');
    expect(vars[2]).toBe('500'); // subtotal fallback for total
    expect(vars[4]).toBe('counter'); // non-empty fallback for an unsettled method
  });

  it('counts 0 items cleanly when the order carries no items array', () => {
    const vars = templateVarsFor(billOrder({ items: undefined }), 'bill');
    expect(vars[3]).toBe('0');
  });

  it('renderNotification("bill") body includes the total and payment method', () => {
    const { body } = renderNotification(billOrder(), 'bill');
    expect(body).toContain('₹540'); // total
    expect(body).toContain('UPI'); // payment method
    expect(body).toContain('3 item(s)'); // item count
    expect(body).toMatch(/\/order\/order-abc\/receipt/); // receipt link
  });
});
