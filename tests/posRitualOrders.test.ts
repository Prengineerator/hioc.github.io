import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// HIOC Ritual on the counter's order screens (docs/COFFEE-PASS-SPEC.md §7, §8):
// a pass SALE is a payment, not food. It never appears on the live kitchen board,
// it is labelled "HIOC Ritual sale" on the Orders list, and its detail view drops
// every kitchen action (the status API refuses them) but keeps payment, receipt
// and refund. Server-rendered: there is no DOM in this suite.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/staff',
}));

import { OrderDetailModal } from '@/components/staff/OrderDetailModal';
import { OrderQueueBoard } from '@/components/staff/OrderQueueBoard';
import { PosPaymentPanel } from '@/components/staff/PosPaymentModal';
import { SettlePaymentDialog } from '@/components/staff/SettlePaymentDialog';
import { TodayOrdersList } from '@/components/staff/TodayOrdersList';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { Order, OrderItem } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

function line(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'item-1',
    order_id: 'order-1',
    menu_item_id: 'menu-1',
    variant_id: null,
    name_snapshot: 'Cappuccino',
    variant_label_snapshot: 'L',
    price_inr_snapshot: 120,
    quantity: 1,
    line_total_inr: 120,
    special_instructions: '',
    addons: [],
    voided: false,
    void_reason: '',
    voided_by: null,
    voided_at: null,
    ...overrides,
  };
}

function order(overrides: Partial<OrderWithItems> = {}): OrderWithItems {
  return {
    id: 'order-1',
    order_number: 1042,
    customer_name: 'Aisha Khan',
    customer_phone: '+919000000000',
    customer_email: null,
    pickup_time: '',
    status: 'accepted',
    subtotal_inr: 120,
    notes: '',
    created_at: '2026-09-29T10:00:00.000Z',
    updated_at: '2026-09-29T10:00:00.000Z',
    order_type: 'takeaway',
    promised_ready_at: null,
    pickup_code: '4821',
    pickup_slot_start: null,
    pickup_slot_label: 'ASAP',
    tax_inr: 6,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: 126,
    payment_status: 'unpaid',
    payment_method: null,
    reject_reason: '',
    version: 1,
    user_id: null,
    channel: 'staff_pos',
    table_id: null,
    table_label: '',
    created_by: 'staff-1',
    customer_user_id: null,
    items: [line()],
    ...overrides,
  };
}

const planLine = line({
  id: 'plan-line',
  menu_item_id: null,
  name_snapshot: 'Weekly Ritual',
  variant_label_snapshot: '7 cups · 7 days',
  price_inr_snapshot: 750,
  line_total_inr: 750,
  coffee_pass_plan_id: 'plan-1',
});

const sale = (overrides: Partial<OrderWithItems> = {}) =>
  order({
    id: 'sale-1',
    order_number: 1043,
    order_kind: 'coffee_pass',
    pickup_code: null,
    pickup_slot_label: '',
    subtotal_inr: 750,
    tax_inr: 38,
    total_inr: 788,
    items: [planLine],
    ...overrides,
  });

const noop = () => {};
const MENU_NO = `#${formatOrderNumber(1042)}`;
const SALE_NO = `#${formatOrderNumber(1043)}`;

describe('the live kitchen board', () => {
  const board = (orders: OrderWithItems[]) =>
    renderToStaticMarkup(
      createElement(OrderQueueBoard, {
        orders,
        busyIds: new Set<string>(),
        onOpen: noop,
        onAction: noop,
        onRemind: () => Promise.resolve(),
      }),
    );

  it('never shows a pass sale, even while it sits accepted and unpaid', () => {
    const html = board([order(), sale()]);
    expect(html).toContain(MENU_NO);
    expect(html).not.toContain(SALE_NO);
    expect(html).not.toContain('Weekly Ritual');
    expect(html).toContain('1 active order');
  });

  it('says there is nothing to prepare when the only open order is a pass sale', () => {
    expect(board([sale()])).toContain('No active orders');
  });

  it('shows a menu order that carries no order_kind (a row read before the migration)', () => {
    expect(board([order({ order_kind: undefined })])).toContain(MENU_NO);
  });
});

describe('the Orders list', () => {
  const list = (orders: OrderWithItems[]) =>
    renderToStaticMarkup(createElement(TodayOrdersList, { orders, onOpen: noop, dayLabel: 'today' }));

  it('labels a pass sale "HIOC Ritual sale" and gives it no table, token or item count', () => {
    const html = list([sale()]);
    expect(html).toContain(SALE_NO);
    expect(html).toContain('HIOC Ritual sale');
    // The row itself (the type filter above the list still names "Takeaway").
    expect(html).not.toContain('· Takeaway');
    expect(html).not.toMatch(/· \d+ items?/);
    expect(html).toContain('₹788');
  });

  it('leaves an ordinary order as it was', () => {
    const html = list([order()]);
    expect(html).not.toContain('HIOC Ritual sale');
    expect(html).toContain('Token 4821');
    expect(html).toContain('1 item');
  });
});

describe('the order detail', () => {
  const detail = (o: OrderWithItems) =>
    renderToStaticMarkup(
      createElement(OrderDetailModal, {
        order: o,
        onClose: noop,
        onPrint: noop,
        onTransition: noop,
        onPayment: () => Promise.resolve(true),
        onRefund: noop,
        onOpenPayment: noop,
      }),
    );

  it('drops the kitchen actions for an unpaid pass sale but keeps payment and receipt', () => {
    const html = detail(sale());
    expect(html).toContain('HIOC Ritual sale');
    expect(html).not.toContain('Print KOT');
    expect(html).not.toContain('Print token');
    expect(html).not.toMatch(/>Accept</);
    expect(html).not.toMatch(/>Reject</);
    expect(html).not.toContain('Mark ');
    expect(html).not.toContain('Cancel order');
    expect(html).not.toContain('Pickup:');
    expect(html).not.toContain('Elapsed');
    expect(html).toContain('Print receipt');
    expect(html).toContain('Split or cash with change');
    // The one status move the API allows on a sale.
    expect(html).toContain('Cancel sale');
  });

  it('keeps refund on a paid pass sale, tells the manager it cancels the pass, and offers no cancel', () => {
    const html = detail(sale({ status: 'completed', payment_status: 'paid', payment_method: 'cash' }));
    expect(html).toContain('Refund (manager)');
    expect(html).toContain('Change payment');
    expect(html).not.toContain('Cancel sale');
    expect(html).not.toContain('Print KOT');
  });

  it('shows an ordinary order exactly as before: KOT, accept and the rest', () => {
    const html = detail(order({ status: 'received' }));
    expect(html).toContain('Print KOT');
    expect(html).toMatch(/>Accept</);
    expect(html).toContain('Pickup:');
  });

  it('shows the cups a pass paid for, and what they covered, on a menu order', () => {
    const html = detail(
      order({
        status: 'received',
        subtotal_inr: 335,
        total_inr: 68,
        pass_discount_inr: 270,
        items: [
          line({ id: 'a', name_snapshot: 'Lotus Biscoff Latte', quantity: 1, line_total_inr: 215, pass_drinks: 1, pass_covered_inr: 150 }),
          line({ id: 'b', quantity: 1, line_total_inr: 120, pass_drinks: 1, pass_covered_inr: 120 }),
        ],
      }),
    );
    expect(html).toContain('HIOC Ritual (2 cups)');
    expect(html).toContain('-₹270');
    expect(html).toContain('Ritual ×1 · ₹150 covered');
    expect(html).toContain('₹68');
  });
});

describe('the payment step', () => {
  const panel = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(PosPaymentPanel, {
        bill: null,
        orderType: 'takeaway',
        tableLabel: null,
        itemCount: 1,
        phone: '',
        onPhoneChange: noop,
        submitting: false,
        error: null,
        onSubmit: noop,
        onClose: noop,
        ...props,
      } as never),
    );

  it('names a pass sale and its plan in place of "Takeaway · 1 item", and offers every tender but "collect later"', () => {
    const html = panel({
      mode: 'settle',
      bill: { subtotal_inr: 750, tax_inr: 38, packaging_inr: 0, discount_inr: 0, total_inr: 788 },
      contextLabel: 'HIOC Ritual sale',
      contextDetail: 'Weekly Ritual · 7 cups · 7 days',
    });
    expect(html).toContain('HIOC Ritual sale');
    expect(html).toContain('Weekly Ritual · 7 cups · 7 days');
    expect(html).not.toContain('Takeaway');
    expect(html).toContain('Cash');
    expect(html).toContain('UPI');
    expect(html).toContain('Split across two methods');
    expect(html).not.toContain('Collect later');
    expect(html).toContain('₹788');
  });

  it('shows what HIOC Ritual cups cover as its own row between Discount and the total', () => {
    const html = panel({
      bill: { subtotal_inr: 335, tax_inr: 3, packaging_inr: 0, discount_inr: 20, pass_discount_inr: 270, total_inr: 48 },
      passCups: 2,
    });
    const discount = html.indexOf('Discount');
    const ritual = html.indexOf('HIOC Ritual (2 cups)');
    expect(discount).toBeGreaterThan(-1);
    expect(ritual).toBeGreaterThan(discount);
    expect(html).toContain('-₹270');
    expect(html.indexOf('Total')).toBeGreaterThan(ritual);
  });

  it('says plainly there is nothing to collect when the cups bring the bill to ₹0, and places the order without a payment', () => {
    const html = panel({
      bill: { subtotal_inr: 120, tax_inr: 0, packaging_inr: 0, discount_inr: 0, pass_discount_inr: 120, total_inr: 0 },
      passCups: 1,
    });
    expect(html).toContain('HIOC Ritual covers this order');
    expect(html).toContain('Place order — ₹0 due');
    // No tender to choose, no cash step: parts must be a positive number of rupees.
    expect(html).not.toContain('Collect now');
    expect(html).not.toContain('Split across two methods');
  });

  it('a settled bill is never treated as ₹0 (the settle step always collects)', () => {
    const html = panel({
      mode: 'settle',
      bill: { subtotal_inr: 750, tax_inr: 0, packaging_inr: 0, discount_inr: 0, total_inr: 0 },
    });
    expect(html).toContain('Collect now');
  });

  it('leaves an ordinary bill as it was: no Ritual row, the tenders on offer', () => {
    const html = panel({ bill: { subtotal_inr: 120, tax_inr: 6, packaging_inr: 0, discount_inr: 0, total_inr: 126 } });
    expect(html).not.toContain('HIOC Ritual');
    expect(html).toContain('Collect now');
    expect(html).toContain('Collect later');
  });
});

describe('SettlePaymentDialog', () => {
  it('renders on the server without throwing (it portals to document.body, which is absent here)', () => {
    expect(() =>
      renderToStaticMarkup(createElement(SettlePaymentDialog, { order: sale(), intent: 'settle', onClose: noop, onDone: noop })),
    ).not.toThrow();
  });
});
