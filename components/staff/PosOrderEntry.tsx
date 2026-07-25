'use client';

// Staff POS-lite order entry (POS-1) — the counter-tablet screen that punches a
// dine-in or walk-in order into the SAME pipeline the website uses. Tablet-first
// two-pane layout: a searchable, category-tabbed menu grid on the left; a running
// order (cart, order-type toggle, table picker, live bill, optional customer
// capture, and the Collect-payment step) on the right.
//
// GUARDRAILS honored here:
//  - The client NEVER computes money. Every bill line shown comes from
//    POST /api/orders/quote (re-quoted whenever the cart or order-type changes).
//    The client-side subtotal exists ONLY as the quote's input, exactly like the
//    customer CheckoutForm.
//  - The variant/addon min/max rules match the web flow (PosCustomizeModal is a
//    deliberate sibling of the customer modal so they can't drift).
//  - 86'd items are greyed out live (isMenuItemAvailable + the availability
//    realtime hook), same rule/data the customer menu uses.
//  - Double-submit is guarded by an in-flight ref plus disabled controls.
//
// The cart is POS-local React state (not the shared localStorage CartContext) so
// a staff tablet can never collide with a customer's web cart; it still reuses
// the CartItem shape + computeCartKey so the line-merge mechanics match the web.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MenuCategoryTabs } from '@/components/menu/MenuCategoryTabs';
import { PosCustomizeModal } from '@/components/staff/PosCustomizeModal';
import { PosPaymentModal } from '@/components/staff/PosPaymentModal';
import { Spinner } from '@/components/ui/Spinner';
import { computeCartKey } from '@/lib/cart/cartKey';
import type { CartItem } from '@/lib/cart/CartContext';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { useMenuAvailabilityRealtime } from '@/lib/realtime/hooks';
import { normalizeIndianMobile } from '@/lib/phone';
import { normalizeEmail } from '@/lib/email';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { MENU_CATEGORIES } from '@/lib/constants';
import type { BillBreakdown } from '@/lib/store/hours';
import type { MenuItem, OrderType, PaymentMethod } from '@/lib/types';

const DEFAULT_CATEGORY = MENU_CATEGORIES[0].slug;

interface StaffTable {
  id: string;
  label: string;
  zone: string;
  capacity: number;
  is_active: boolean;
  sort_order: number;
}

export function PosOrderEntry() {
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [search, setSearch] = useState('');

  const [cart, setCart] = useState<CartItem[]>([]);
  const [orderType, setOrderType] = useState<OrderType>('dine_in');

  const [tables, setTables] = useState<StaffTable[]>([]);
  const [tableId, setTableId] = useState<string | null>(null);

  const [showCustomer, setShowCustomer] = useState(false);
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [contactError, setContactError] = useState<string | null>(null);

  const [bill, setBill] = useState<BillBreakdown | null>(null);
  const [customizing, setCustomizing] = useState<MenuItem | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const inFlight = useRef(false);
  const cartRef = useRef(cart);
  cartRef.current = cart;

  // --- Menu (all categories in one fetch so search spans the whole menu) ----
  const fetchMenu = useCallback(() => {
    fetch('/api/menu?includeUnavailable=true', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { items?: MenuItem[] }) => setMenuItems(data.items ?? []))
      .catch(() => {})
      .finally(() => setMenuLoading(false));
  }, []);

  useEffect(() => {
    fetchMenu();
  }, [fetchMenu]);

  // Live 86/un-86: refetch the menu when availability changes so greyed-out
  // state updates within a few seconds (same hook the customer menu uses).
  useMenuAvailabilityRealtime(fetchMenu);

  // --- Tables (for the dine-in picker) --------------------------------------
  const fetchTables = useCallback(() => {
    fetch('/api/tables', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { tables: [] }))
      .then((data: { tables?: StaffTable[] }) => setTables(data.tables ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchTables();
  }, [fetchTables]);

  // --- Derived --------------------------------------------------------------
  const totalItems = useMemo(() => cart.reduce((s, i) => s + i.qty, 0), [cart]);
  const subtotal = useMemo(
    () => cart.reduce((s, i) => s + i.qty * i.unitPriceInr, 0),
    [cart],
  );

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q) {
      // Search spans every category so staff find items fast.
      return menuItems.filter((i) => i.name.toLowerCase().includes(q));
    }
    return menuItems.filter((i) => i.category === category);
  }, [menuItems, category, search]);

  // --- Live bill from the quote endpoint (never computed client-side) -------
  useEffect(() => {
    if (subtotal <= 0) {
      setBill(null);
      return;
    }
    let cancelled = false;
    // Small debounce so rapid qty taps don't fire a burst of quotes.
    const t = setTimeout(() => {
      fetch('/api/orders/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtotal_inr: subtotal,
          order_type: orderType,
          item_ids: cartRef.current.map((i) => i.menuItemId),
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { bill?: BillBreakdown } | null) => {
          if (!cancelled && data?.bill) setBill(data.bill);
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [subtotal, orderType]);

  // --- Cart ops (reuse the web line-merge key so mechanics match) -----------
  const addLine = useCallback((line: Omit<CartItem, 'qty' | 'key'>, qty = 1) => {
    const key = computeCartKey(
      line.menuItemId,
      line.variantId,
      line.addons.map((a) => a.optionId),
      line.specialInstructions,
    );
    setCart((prev) => {
      const existing = prev.find((i) => i.key === key);
      if (existing) return prev.map((i) => (i.key === key ? { ...i, qty: i.qty + qty } : i));
      return [...prev, { ...line, key, qty }];
    });
  }, []);

  const increment = useCallback((key: string) => {
    setCart((prev) => prev.map((i) => (i.key === key ? { ...i, qty: i.qty + 1 } : i)));
  }, []);
  const decrement = useCallback((key: string) => {
    setCart((prev) =>
      prev.map((i) => (i.key === key ? { ...i, qty: i.qty - 1 } : i)).filter((i) => i.qty > 0),
    );
  }, []);
  const removeLine = useCallback((key: string) => {
    setCart((prev) => prev.filter((i) => i.key !== key));
  }, []);

  function handleTapItem(item: MenuItem) {
    if (!isMenuItemAvailable(item)) return;
    const isSimple = item.variants.length === 1 && item.addon_groups.length === 0;
    const onlyVariant = item.variants[0];
    if (isSimple && onlyVariant) {
      addLine({
        menuItemId: item.id,
        variantId: onlyVariant.id,
        name: item.name,
        variantLabel: onlyVariant.label,
        unitPriceInr: onlyVariant.price_inr,
        addons: [],
        specialInstructions: '',
      });
      return;
    }
    setCustomizing(item);
  }

  // --- Validation for enabling the Collect-payment step ---------------------
  const dineInNeedsTable = orderType === 'dine_in' && !tableId;
  const canProceed = cart.length > 0 && !dineInNeedsTable;

  function validateContact(): boolean {
    if (custPhone.trim() && normalizeIndianMobile(custPhone) === null) {
      setContactError('Enter a valid 10-digit Indian mobile number, or leave it blank.');
      return false;
    }
    if (custEmail.trim() && normalizeEmail(custEmail) === null) {
      setContactError('Enter a valid email address, or leave it blank.');
      return false;
    }
    setContactError(null);
    return true;
  }

  function openPayment() {
    if (!canProceed) return;
    if (!validateContact()) {
      setShowCustomer(true);
      return;
    }
    setSubmitError(null);
    setPaymentOpen(true);
  }

  const selectedTableLabel = tables.find((t) => t.id === tableId)?.label ?? null;

  // --- Create (+ optionally settle) -----------------------------------------
  async function placeOrder(method: PaymentMethod | null) {
    // Double-submit guard: the ref blocks a second entry even before the
    // `submitting` state has flushed to disable the buttons.
    if (inFlight.current) return;
    if (!canProceed) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const body: Record<string, unknown> = {
        items: cart.map((i) => ({
          menu_item_id: i.menuItemId,
          variant_id: i.variantId,
          quantity: i.qty,
          addon_option_ids: i.addons.map((a) => a.optionId),
          special_instructions: i.specialInstructions,
        })),
      };
      if (orderType === 'dine_in') {
        body.order_type = 'dine_in';
        body.table_id = tableId;
      } else {
        // Staff walk-in takeaway keeps the token/pickup flow — the create route
        // requires a slot label for a non-dine-in staff order. ASAP = counter.
        body.pickup_slot_label = 'ASAP';
      }
      if (custName.trim()) body.customer_name = custName.trim();
      if (custPhone.trim()) body.customer_phone = custPhone.trim();
      if (custEmail.trim()) body.customer_email = custEmail.trim();

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status !== 201) {
        const data = await res.json().catch(() => ({}));
        setSubmitError(data.error ?? 'Could not place the order. Please try again.');
        return;
      }

      const { order } = (await res.json()) as { order: { id: string; order_number: number } };
      const numberLabel = formatOrderNumber(order.order_number);

      // Collect now → settle via the existing payment route (cash/UPI/card).
      // Collect later → leave it unpaid for POS-2 to settle from the detail.
      if (method) {
        const payRes = await fetch(`/api/orders/${order.id}/payment`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payment_method: method }),
        });
        if (!payRes.ok) {
          // The order is already created and on the board — a settle failure is
          // recoverable from the queue, so don't strand the counter here.
          resetForNextOrder();
          showToast(`Order #${numberLabel} placed — payment not recorded, settle it from Orders.`);
          return;
        }
      }

      resetForNextOrder();
      showToast(
        method
          ? `Order #${numberLabel} placed & paid (${method.toUpperCase()}).`
          : `Order #${numberLabel} placed — collect payment later.`,
      );
    } catch {
      setSubmitError('Network error — please check the connection and try again.');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function resetForNextOrder() {
    setCart([]);
    setBill(null);
    setTableId(null);
    setCustName('');
    setCustPhone('');
    setCustEmail('');
    setContactError(null);
    setShowCustomer(false);
    setPaymentOpen(false);
    setSearch('');
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000);
  }

  const displaySubtotal = bill?.subtotal_inr ?? subtotal;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">New order</h1>
          <p className="text-sm text-muted">Punch in a dine-in or walk-in order.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ---- Menu ---- */}
        <div className="lg:col-span-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the menu…"
            className="mb-3 w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-sm outline-none focus:border-tan"
          />
          {!search ? (
            <div className="mb-4">
              <MenuCategoryTabs active={category} onChange={setCategory} />
            </div>
          ) : null}

          {menuLoading ? (
            <Spinner label="Loading menu…" />
          ) : visibleItems.length === 0 ? (
            <p className="rounded-md border border-line bg-cream p-6 text-center text-sm text-muted">
              {search ? 'No items match your search.' : 'No items in this category.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {visibleItems.map((item) => (
                <PosMenuTile key={item.id} item={item} onTap={() => handleTapItem(item)} />
              ))}
            </div>
          )}
        </div>

        {/* ---- Order panel ---- */}
        <div className="lg:col-span-1">
          <div className="sticky top-20 flex flex-col gap-4 rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
            {/* Order type toggle */}
            <div className="grid grid-cols-2 gap-2">
              {(['dine_in', 'takeaway'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setOrderType(t);
                    if (t === 'takeaway') setTableId(null);
                  }}
                  className={
                    'rounded-md border px-3 py-2 text-sm font-bold transition-colors ' +
                    (orderType === t
                      ? 'border-tan bg-[#f6efe9] text-tan-dark'
                      : 'border-[#e5e5e5] text-charcoal hover:border-tan')
                  }
                >
                  {t === 'dine_in' ? 'Dine-in' : 'Takeaway'}
                </button>
              ))}
            </div>

            {/* Table picker (dine-in only) */}
            {orderType === 'dine_in' ? (
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Table</p>
                {tables.length === 0 ? (
                  <p className="text-sm text-muted">
                    No active tables — add tables in the owner settings first.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {tables.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTableId(t.id)}
                        className={
                          'rounded-md border px-3 py-2 text-sm font-bold transition-colors ' +
                          (tableId === t.id
                            ? 'border-tan bg-tan text-cream'
                            : 'border-[#e5e5e5] text-charcoal hover:border-tan')
                        }
                        title={t.zone || undefined}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {/* Cart */}
            <div>
              <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">
                Order {totalItems > 0 ? `· ${totalItems} item${totalItems === 1 ? '' : 's'}` : ''}
              </p>
              {cart.length === 0 ? (
                <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-muted">
                  Tap items to add them.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {cart.map((line) => (
                    <li key={line.key} className="flex items-start gap-2 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-charcoal">{line.name}</p>
                        <p className="truncate text-xs text-muted">
                          {line.variantLabel}
                          {line.addons.length > 0
                            ? ` · ${line.addons.map((a) => a.optionName).join(', ')}`
                            : ''}
                        </p>
                        {line.specialInstructions ? (
                          <p className="truncate text-xs italic text-muted">
                            “{line.specialInstructions}”
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          aria-label="Decrease quantity"
                          onClick={() => decrement(line.key)}
                          className="flex h-7 w-7 items-center justify-center rounded-full bg-charcoal text-cream"
                        >
                          &minus;
                        </button>
                        <span className="min-w-[1.25rem] text-center text-sm font-bold text-charcoal">
                          {line.qty}
                        </span>
                        <button
                          type="button"
                          aria-label="Increase quantity"
                          onClick={() => increment(line.key)}
                          className="flex h-7 w-7 items-center justify-center rounded-full bg-tan text-cream"
                        >
                          +
                        </button>
                      </div>
                      <div className="w-14 shrink-0 text-right text-sm font-bold text-charcoal">
                        ₹{line.unitPriceInr * line.qty}
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${line.name}`}
                        onClick={() => removeLine(line.key)}
                        className="shrink-0 rounded-full px-1 text-lg leading-none text-muted hover:text-red-700"
                      >
                        &times;
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Bill breakup (all numbers from the quote endpoint) */}
            {cart.length > 0 ? (
              <div className="rounded-md border border-[#e5e5e5] px-3 py-2 text-sm text-charcoal">
                <BillRow label="Subtotal" value={displaySubtotal} />
                {bill && bill.tax_inr > 0 ? <BillRow label="GST" value={bill.tax_inr} /> : null}
                {bill && bill.packaging_inr > 0 ? (
                  <BillRow label="Packaging" value={bill.packaging_inr} />
                ) : null}
                <div className="mt-1 flex items-center justify-between border-t border-[#e5e5e5] pt-1">
                  <span className="font-bold">Total</span>
                  <span className="font-bold text-tan">
                    {bill ? `₹${bill.total_inr}` : 'Calculating…'}
                  </span>
                </div>
              </div>
            ) : null}

            {/* Optional customer capture — skippable in one tap */}
            {showCustomer ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold uppercase tracking-wide text-muted">
                    Customer (optional)
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCustomer(false);
                      setCustName('');
                      setCustPhone('');
                      setCustEmail('');
                      setContactError(null);
                    }}
                    className="text-xs font-bold text-muted underline"
                  >
                    Skip
                  </button>
                </div>
                <input
                  value={custName}
                  onChange={(e) => setCustName(e.target.value)}
                  placeholder="Name"
                  className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-sm outline-none focus:border-tan"
                />
                <input
                  value={custPhone}
                  onChange={(e) => {
                    setCustPhone(e.target.value);
                    if (contactError) setContactError(null);
                  }}
                  inputMode="tel"
                  placeholder="Phone (for the bill on WhatsApp)"
                  className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-sm outline-none focus:border-tan"
                />
                <input
                  value={custEmail}
                  onChange={(e) => {
                    setCustEmail(e.target.value);
                    if (contactError) setContactError(null);
                  }}
                  inputMode="email"
                  placeholder="Email (optional)"
                  className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-sm outline-none focus:border-tan"
                />
                {contactError ? <p className="text-xs text-red-700">{contactError}</p> : null}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCustomer(true)}
                className="text-left text-sm font-bold text-tan underline"
              >
                + Add customer details
              </button>
            )}

            {submitError && !paymentOpen ? (
              <p role="alert" className="text-sm text-red-700">
                {submitError}
              </p>
            ) : null}

            {/* Proceed to Collect payment */}
            <button
              type="button"
              disabled={!canProceed || submitting}
              onClick={openPayment}
              className="w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cart.length === 0
                ? 'Add items to continue'
                : dineInNeedsTable
                  ? 'Select a table'
                  : bill
                    ? `Charge ₹${bill.total_inr}`
                    : 'Review & pay'}
            </button>
          </div>
        </div>
      </div>

      {customizing ? (
        <PosCustomizeModal
          item={customizing}
          onAdd={addLine}
          onClose={() => setCustomizing(null)}
        />
      ) : null}

      {paymentOpen ? (
        <PosPaymentModal
          bill={bill}
          orderType={orderType}
          tableLabel={selectedTableLabel}
          itemCount={totalItems}
          submitting={submitting}
          error={submitError}
          onSubmit={placeOrder}
          onClose={() => {
            if (!submitting) {
              setPaymentOpen(false);
              setSubmitError(null);
            }
          }}
        />
      ) : null}

      {toast ? (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-md bg-charcoal px-4 py-2 text-sm text-cream shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function BillRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span>{label}</span>
      <span>{value < 0 ? `-₹${Math.abs(value)}` : `₹${value}`}</span>
    </div>
  );
}

// Compact tap-to-add menu tile. Greys out + disables 86'd items live (same rule
// as the customer menu). Tapping a simple item adds it straight to the order;
// an item with variants/addons opens the customize modal (handled by the parent).
function PosMenuTile({ item, onTap }: { item: MenuItem; onTap: () => void }) {
  const available = isMenuItemAvailable(item);
  const minPrice = Math.min(...item.variants.map((v) => v.price_inr));
  const priceLabel = item.variants.length > 1 ? `from ₹${minPrice}` : `₹${minPrice}`;

  return (
    <button
      type="button"
      onClick={onTap}
      disabled={!available}
      aria-label={available ? `Add ${item.name}` : `${item.name} unavailable`}
      className={
        'flex min-h-[84px] flex-col items-start justify-between rounded-md border border-[#e5e5e5] bg-cream p-3 text-left transition-colors ' +
        (available
          ? 'hover:border-tan focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan'
          : 'cursor-not-allowed opacity-40')
      }
    >
      <span className="flex items-start gap-1.5">
        <span
          aria-hidden
          className={
            'mt-1 flex h-3 w-3 shrink-0 items-center justify-center border ' +
            (item.is_veg ? 'border-green-700' : 'border-red-700')
          }
        >
          <span className={'h-1 w-1 rounded-full ' + (item.is_veg ? 'bg-green-700' : 'bg-red-700')} />
        </span>
        <span className="line-clamp-2 text-sm font-bold text-charcoal">{item.name}</span>
      </span>
      <span className="mt-2 flex w-full items-center justify-between">
        <span className="text-xs font-bold text-tan">{priceLabel}</span>
        {!available ? <span className="text-[10px] font-bold text-muted">86’d</span> : null}
      </span>
    </button>
  );
}
