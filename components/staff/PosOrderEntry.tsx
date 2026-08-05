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
import { useRouter } from 'next/navigation';
import { MenuCategoryTabs } from '@/components/menu/MenuCategoryTabs';
import { PosCustomizeModal } from '@/components/staff/PosCustomizeModal';
import { PosPaymentModal } from '@/components/staff/PosPaymentModal';
import { PosQuickAddBar } from '@/components/staff/PosQuickAddBar';
import { Spinner } from '@/components/ui/Spinner';
import { isSimpleItem, parseQuickAddInput, resolveQuickAdd } from '@/lib/pos/quickAdd';
import { pushRecent, readRecents } from '@/lib/pos/recents';
import { computeCartKey } from '@/lib/cart/cartKey';
import type { CartItem } from '@/lib/cart/CartContext';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { useMenuAvailabilityRealtime } from '@/lib/realtime/hooks';
import { normalizeIndianMobile } from '@/lib/phone';
import { normalizeEmail } from '@/lib/email';
import type { PaymentPart } from '@/lib/orders/payments';
import {
  AUTO_PRINT_DEFAULTS,
  placementPrintPlan,
  printUrl,
  readAutoPrintSettings,
  type AutoPrintSettings,
  type PrintType,
} from '@/lib/staff/autoPrint';
import {
  describePaymentParts,
  parseResendResult,
  placementBillStatus,
  type BillStatusView,
} from '@/lib/staff/confirmation';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { MENU_CATEGORIES } from '@/lib/constants';
import type { BillBreakdown } from '@/lib/store/hours';
import type { MenuItem, OrderType, StoreSettings } from '@/lib/types';

const DEFAULT_CATEGORY = MENU_CATEGORIES[0].slug;

// POS4-4 — how long the confirmation stays before clearing itself. Long enough
// to read the change due and reach for an action, short enough that it's gone
// by the time the next customer's order is punched.
const CONFIRM_MS = 12000;

/**
 * POS4-4 — what the counter needs to see after committing an order: the number
 * to call out, what was taken, what to hand back, and whether the bill actually
 * left the building. Every rupee here came from the server.
 */
interface PlacementConfirmation {
  orderId: string;
  numberLabel: string;
  totalInr: number;
  /** null → placed unpaid ("collect later"); otherwise how it was settled. */
  paidAs: string | null;
  changeDueInr: number;
  /** null → nothing was due to send yet (the order isn't settled). */
  bill: BillStatusView | null;
  canResend: boolean;
  /** Something the staffer must act on: a failed settle, a blocked pop-up. */
  note: string | null;
}

// POS4-2 — a per-attempt key for POST /api/orders. crypto.randomUUID is present
// in every browser this POS runs on; the timestamp+random fallback keeps an old
// tablet working rather than silently dropping replay protection.
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pos-${crypto.randomUUID()}`;
  }
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

// POS4-3 — a browser only allows a pop-up while it still counts the staffer's
// tap as the reason this code is running. The order id doesn't exist until the
// POST returns, so the tab is opened blank INSIDE the click and pointed at the
// print page afterwards; calling window.open after the await is an unrequested
// pop-up and gets blocked.
//
// 'noopener' is deliberately absent (the manual Print buttons do use it): it
// makes window.open return null, and we need the handle to set the location.
// The target is our own same-origin, staff-gated print page.
function openBlankPrintWindow(): Window | null {
  try {
    return window.open('', '_blank');
  } catch {
    return null;
  }
}

interface StaffTable {
  id: string;
  label: string;
  zone: string;
  capacity: number;
  is_active: boolean;
  sort_order: number;
}

/**
 * TAB-2 — when present, the screen is in "add to a running order" mode: the
 * cart is appended to an EXISTING order via the amend engine rather than
 * creating a new one. Order type, table and customer capture all belong to the
 * order already, so they're hidden; there is no payment step (the tab is settled
 * later, once).
 */
export interface AddToOrderTarget {
  id: string;
  orderNumber: number;
  tableLabel: string | null;
}

export function PosOrderEntry({
  initialTableId,
  addToOrder = null,
}: { initialTableId?: string | null; addToOrder?: AddToOrderTarget | null } = {}) {
  const isAddMode = addToOrder !== null;
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [search, setSearch] = useState('');

  const [cart, setCart] = useState<CartItem[]>([]);
  const [orderType, setOrderType] = useState<OrderType>('dine_in');

  const [tables, setTables] = useState<StaffTable[]>([]);
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableFilter, setTableFilter] = useState(''); // POS4-5, shown past ~12 tables

  const [showCustomer, setShowCustomer] = useState(false);
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [contactError, setContactError] = useState<string | null>(null);

  const [bill, setBill] = useState<BillBreakdown | null>(null);
  const [customizing, setCustomizing] = useState<MenuItem | null>(null);
  const [pendingQty, setPendingQty] = useState(1); // qty carried from "3*latte" into the modal
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]); // "Quick picks" (this tablet)
  // POS4-3/4 — the close of the counter loop.
  const [autoPrint, setAutoPrint] = useState<AutoPrintSettings>(AUTO_PRINT_DEFAULTS);
  const [confirmation, setConfirmation] = useState<PlacementConfirmation | null>(null);
  const [resending, setResending] = useState(false);

  const router = useRouter();
  const inFlight = useRef(false);
  // POS4-2 — identifies THIS order attempt across retries. Rotated only once an
  // order is actually placed, so a retry after a network failure replays rather
  // than creating a duplicate.
  const idempotencyKey = useRef(newIdempotencyKey());
  const barRef = useRef<HTMLInputElement>(null); // command bar, for sticky refocus
  const cartRef = useRef(cart);
  cartRef.current = cart;

  // Seed recents from localStorage once on mount (client-only).
  useEffect(() => {
    setRecentIds(readRecents());
  }, []);

  // POS4-3 — the owner's auto-print switches. Read once: a shift doesn't change
  // them, and this must be settled long before the first Charge. Any failure
  // (offline, or a deploy that predates the migration) leaves the documented
  // defaults in place rather than silently stopping the kitchen's ticket.
  useEffect(() => {
    fetch('/api/store-settings', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { settings?: StoreSettings } | null) => {
        setAutoPrint(readAutoPrintSettings(data?.settings));
      })
      .catch(() => {});
  }, []);

  // POS4-4 — the confirmation is a report, not a gate: it clears itself so a
  // staffer already punching the next order never has to dismiss it. Any action
  // taken on it replaces the object, which restarts this timer — someone still
  // reading it doesn't lose it mid-tap.
  useEffect(() => {
    if (!confirmation) return;
    const t = setTimeout(() => setConfirmation(null), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmation]);

  // Sticky keyboard-first focus: keep the command bar focused on mount and
  // whenever a modal closes, but never steal focus while a modal is open (or the
  // effect would fight the customize/payment modals and the customer/table fields).
  useEffect(() => {
    if (customizing || paymentOpen) return;
    barRef.current?.focus();
  }, [customizing, paymentOpen]);

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

  // Pre-select a table passed in from the tables board deep-link (POS-3 →
  // /staff/orders/new?table=<id>). Applied ONCE, and only after the active-tables
  // list has loaded so we can validate the id against it — an unknown/inactive id
  // is ignored (the picker just stays empty). Forcing dine-in matches the intent
  // of arriving from a table tile; a later manual change by staff sticks because
  // the ref stops us from re-applying.
  const appliedInitialTable = useRef(false);
  useEffect(() => {
    if (appliedInitialTable.current || !initialTableId || tables.length === 0) return;
    const match = tables.find((t) => t.id === initialTableId);
    if (match) {
      setOrderType('dine_in');
      setTableId(match.id);
    }
    appliedInitialTable.current = true;
  }, [initialTableId, tables]);

  // --- Derived --------------------------------------------------------------
  const totalItems = useMemo(() => cart.reduce((s, i) => s + i.qty, 0), [cart]);
  const subtotal = useMemo(
    () => cart.reduce((s, i) => s + i.qty * i.unitPriceInr, 0),
    [cart],
  );

  // Browse grid: when the bar has a shortform, mirror the SAME ranked resolver
  // the command-bar dropdown uses (so the big touch grid and the keyboard
  // dropdown never disagree); otherwise show the selected category.
  const visibleItems = useMemo(() => {
    const { term } = parseQuickAddInput(search);
    if (term) {
      return resolveQuickAdd(term, menuItems, { limit: 60 }).map((c) => c.item);
    }
    return menuItems.filter((i) => i.category === category);
  }, [menuItems, category, search]);

  // POS4-5 — tables grouped by zone, filtered by the label search. Zone order
  // follows the tables' own sort_order (the API already returns them sorted), so
  // the picker matches the physical room layout the owner configured.
  const tablesByZone = useMemo(() => {
    const term = tableFilter.trim().toLowerCase();
    const matching = term
      ? tables.filter((t) => t.label.toLowerCase().includes(term))
      : tables;
    const groups = new Map<string, StaffTable[]>();
    for (const t of matching) {
      const zone = t.zone?.trim() || 'Tables';
      const list = groups.get(zone) ?? [];
      list.push(t);
      groups.set(zone, list);
    }
    return [...groups.entries()];
  }, [tables, tableFilter]);

  // "Quick picks" strip (empty-query state): recent items resolved to the live
  // menu (drops any that were deleted / are missing).
  const recentItems = useMemo(() => {
    const byId = new Map(menuItems.map((i) => [i.id, i]));
    return recentIds
      .map((id) => byId.get(id))
      .filter((i): i is MenuItem => i !== undefined);
  }, [recentIds, menuItems]);

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
    // Single funnel for every add (tile tap, quick-add, and the modal's onAdd),
    // so "Quick picks" reflects whatever was actually punched.
    setRecentIds(pushRecent(line.menuItemId));
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

  const focusBar = useCallback(() => {
    barRef.current?.focus();
  }, []);

  // The one place that turns "a chosen item + qty" into a cart action. Reused by
  // the tile tap AND the quick-add bar so the add-direct vs. open-modal rule
  // (isSimpleItem) and the 86 guard can't drift between the two entry paths.
  function commitCandidate(item: MenuItem, qty: number) {
    if (!isMenuItemAvailable(item)) {
      // Tiles are already disabled when 86'd; this only fires from the keyboard
      // path (highlight a 86'd row + Enter) — tell the user instead of no-op.
      showToast(`${item.name} is 86’d`);
      return;
    }
    if (isSimpleItem(item)) {
      const onlyVariant = item.variants[0];
      if (!onlyVariant) return;
      addLine(
        {
          menuItemId: item.id,
          variantId: onlyVariant.id,
          name: item.name,
          variantLabel: onlyVariant.label,
          unitPriceInr: onlyVariant.price_inr,
          addons: [],
          specialInstructions: '',
        },
        qty,
      );
      setSearch('');
      focusBar();
      return;
    }
    // Variant/addon item: open the customize modal (required options honored),
    // seeding it with the qty parsed from the shortform.
    setPendingQty(qty);
    setCustomizing(item);
  }

  // Tapping a tile inherits the qty currently typed in the bar ("3*" applies to
  // taps too); on the empty-query browse/recents grids that qty is just 1.
  function handleTapItem(item: MenuItem) {
    commitCandidate(item, parseQuickAddInput(search).qty);
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
  // POS4-1: settlement arrives as PARTS (a single-method payment is just one
  // part), so cash tendered and splits persist truthfully in order_payments and
  // the cash day counts only the cash that actually entered the drawer.
  async function placeOrder(parts: PaymentPart[] | null) {
    // Double-submit guard: the ref blocks a second entry even before the
    // `submitting` state has flushed to disable the buttons.
    if (inFlight.current) return;
    if (!canProceed) return;

    // POS4-3 — everything up to here is synchronous, so we're still inside the
    // staffer's tap: this is the only moment the browser will let us open the
    // print tabs (see openBlankPrintWindow). They're aimed at a real URL below,
    // once the order has an id.
    const plan = placementPrintPlan(autoPrint, { settled: parts !== null });
    const printWindows = plan.map((type) => ({ type, win: openBlankPrintWindow() }));
    const popupBlocked = printWindows.some((p) => p.win === null);
    const sendPrints = (orderId: string, types: PrintType[]) => {
      for (const p of printWindows) {
        if (types.includes(p.type)) p.win?.location.replace(printUrl(orderId, p.type));
        else p.win?.close(); // e.g. the receipt tab when the settle failed
      }
    };
    const abandonPrints = () => {
      for (const p of printWindows) p.win?.close();
    };

    // The contact as it was at placement — resetForNextOrder() clears these
    // fields before the confirmation is built.
    const phoneAtPlacement = custPhone.trim();
    const emailAtPlacement = custEmail.trim();

    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setConfirmation(null);

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

      // POS4-2: one key per attempted order, generated BEFORE the request and
      // reused if this submit is retried — that's what makes a replay
      // recognisable. A fresh key is minted for the next order in
      // resetForNextOrder(); regenerating it here would defeat the guard.
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey.current },
        body: JSON.stringify(body),
      });

      if (res.status !== 201) {
        const data = await res.json().catch(() => ({}));
        abandonPrints();
        setSubmitError(data.error ?? 'Could not place the order. Please try again.');
        return;
      }

      const { order } = (await res.json()) as {
        order: { id: string; order_number: number; total_inr: number | null; subtotal_inr: number };
      };
      const numberLabel = formatOrderNumber(order.order_number);
      // Server-authoritative, like every other rupee on this screen.
      let totalInr = order.total_inr ?? order.subtotal_inr;

      // Collect now → settle via the payment route. Collect later → leave it
      // unpaid for POS-2 to settle from the order detail.
      let changeDue = 0;
      let settled = false;
      let note: string | null = null;
      if (parts) {
        const payRes = await fetch(`/api/orders/${order.id}/payment`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parts }),
        });
        if (payRes.ok) {
          const payData = (await payRes.json().catch(() => ({}))) as {
            change_due_inr?: number;
            order?: { total_inr: number | null; subtotal_inr: number };
          };
          changeDue = payData.change_due_inr ?? 0;
          if (payData.order) totalInr = payData.order.total_inr ?? payData.order.subtotal_inr;
          settled = true;
        } else {
          // The order is already created and on the board — a settle failure is
          // recoverable from the queue, so don't strand the counter here. The
          // kitchen still gets its ticket; the receipt tab is dropped, since
          // nothing was actually paid.
          note = 'Payment not recorded — settle it from Orders.';
        }
      }

      sendPrints(order.id, settled ? plan : plan.filter((t) => t === 'kot'));
      if (popupBlocked && note === null) {
        // Silent here would mean an order cooked with no ticket on the rail.
        note = 'Pop-up blocked — print it from the order.';
      }

      resetForNextOrder();
      setConfirmation({
        orderId: order.id,
        numberLabel,
        totalInr,
        paidAs: settled && parts ? describePaymentParts(parts) : null,
        changeDueInr: changeDue,
        // A bill only exists once the money is taken (BILL-1 fires on 'paid'),
        // so an unpaid or failed settle has nothing to report yet.
        bill: settled ? placementBillStatus({ phone: phoneAtPlacement, email: emailAtPlacement }) : null,
        // Only offer a resend where a bill both exists and has somewhere to go.
        // A button that can only fail is the false-success this phase removes.
        canResend: settled && Boolean(phoneAtPlacement || emailAtPlacement),
        note,
      });
    } catch {
      abandonPrints();
      setSubmitError('Network error — please check the connection and try again.');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  // POS4-4 — "the customer says they didn't get it", answered without leaving
  // the POS. The route reports which channels actually sent, so the confirmation
  // is replaced with the server's word rather than an optimistic "done".
  async function resendConfirmationBill() {
    const target = confirmation;
    if (!target || resending) return;
    setResending(true);
    try {
      const res = await fetch(`/api/orders/${target.orderId}/resend-bill`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      const result = parseResendResult(res.ok, data);
      setConfirmation((cur) => (cur && cur.orderId === target.orderId ? { ...cur, bill: result } : cur));
    } catch {
      setConfirmation((cur) =>
        cur && cur.orderId === target.orderId
          ? { ...cur, bill: { ok: false, message: 'Network error — please try again.' } }
          : cur,
      );
    } finally {
      setResending(false);
    }
  }

  // TAB-2 — append the cart to an existing open order through the amend engine.
  // Totals are recomputed server-side there, so nothing about money is decided
  // here; on success we return to the tables board where the new total shows.
  async function submitAddToOrder() {
    if (!addToOrder || inFlight.current || cart.length === 0) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch(`/api/orders/${addToOrder.id}/amend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 'add',
          items: cart.map((i) => ({
            menu_item_id: i.menuItemId,
            variant_id: i.variantId,
            quantity: i.qty,
            addon_option_ids: i.addons.map((a) => a.optionId),
            special_instructions: i.specialInstructions,
          })),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // A 409 here is the version guard: someone settled or changed the order
        // while this cart was open. The message from the route says so.
        setSubmitError(data.error ?? 'Could not add the items. Please try again.');
        return;
      }

      const label = formatOrderNumber(addToOrder.orderNumber);
      setCart([]);
      setBill(null);
      setSearch('');
      showToast(`Added to order #${label}.`);
      // Back to the board so the running total is visible in context.
      setTimeout(() => router.push('/staff/tables'), 600);
    } catch {
      setSubmitError('Network error — please check the connection and try again.');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function resetForNextOrder() {
    // A new order attempt gets a new key — this is the ONLY place it rotates.
    idempotencyKey.current = newIdempotencyKey();
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
          <h1 className="text-2xl font-bold text-charcoal">
            {isAddMode ? `Add to order #${formatOrderNumber(addToOrder.orderNumber)}` : 'New order'}
          </h1>
          <p className="text-sm text-muted">
            {isAddMode
              ? `These items go onto the existing bill${
                  addToOrder.tableLabel ? ` for ${addToOrder.tableLabel}` : ''
                } — one table, one bill.`
              : 'Punch in a dine-in or walk-in order.'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ---- Menu ---- */}
        <div className="lg:col-span-2">
          <PosQuickAddBar
            items={menuItems}
            query={search}
            onQueryChange={setSearch}
            onPick={commitCandidate}
            onCharge={openPayment}
            inputRef={barRef}
          />

          {!search ? (
            <>
              {recentItems.length > 0 ? (
                <div className="mb-4">
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
                    Quick picks
                  </p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {recentItems.map((item) => (
                      <PosMenuTile key={item.id} item={item} onTap={() => handleTapItem(item)} />
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="mb-4">
                <MenuCategoryTabs active={category} onChange={setCategory} />
              </div>
            </>
          ) : null}

          {menuLoading ? (
            <Spinner label="Loading menu…" />
          ) : visibleItems.length === 0 ? (
            <p className="rounded-md border border-line bg-cream p-6 text-center text-sm text-muted">
              {search ? 'No items match your search.' : 'No items in this category.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {visibleItems.map((item) => (
                <PosMenuTile key={item.id} item={item} onTap={() => handleTapItem(item)} />
              ))}
            </div>
          )}
        </div>

        {/* ---- Order panel ---- */}
        <div className="lg:col-span-1">
          <div className="sticky top-20 flex flex-col gap-4 rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
            {/* Order type toggle — in add mode these belong to the existing
                order and must not be re-decided here. */}
            {!isAddMode ? (
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
            ) : null}

            {/* Table picker (dine-in only) */}
            {!isAddMode && orderType === 'dine_in' ? (
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Table</p>
                {tables.length === 0 ? (
                  <p className="text-sm text-muted">
                    No active tables — add tables in the owner settings first.
                  </p>
                ) : (
                  // POS4-5: grouped by zone (the same grouping the tables board
                  // uses) with a type-to-filter once the list gets long — a flat
                  // wrap of 30 buttons is unusable at a counter.
                  <>
                    {tables.length > 12 ? (
                      <input
                        value={tableFilter}
                        onChange={(e) => setTableFilter(e.target.value)}
                        placeholder="Filter tables…"
                        className="mb-2 w-full rounded-md border border-[#e5e5e5] px-3 py-1.5 text-sm outline-none focus:border-tan"
                      />
                    ) : null}
                    <div className="flex flex-col gap-2">
                      {tablesByZone.length === 0 ? (
                        <p className="text-sm text-muted">No table matches that.</p>
                      ) : (
                        tablesByZone.map(([zone, zoneTables]) => (
                          <div key={zone}>
                            {tablesByZone.length > 1 ? (
                              <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted">
                                {zone}
                              </p>
                            ) : null}
                            <div className="flex flex-wrap gap-2">
                              {zoneTables.map((t) => (
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
                                >
                                  {t.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </>
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

            {/* Bill breakup (all numbers from the quote endpoint). In add mode
                this is only the value of what's being ADDED — the order's real
                new total is recomputed server-side by the amend engine, so we
                label it honestly rather than implying it's the bill. */}
            {cart.length > 0 ? (
              <div className="rounded-md border border-[#e5e5e5] px-3 py-2 text-sm text-charcoal">
                <BillRow label="Subtotal" value={displaySubtotal} />
                {bill && bill.tax_inr > 0 ? <BillRow label="GST" value={bill.tax_inr} /> : null}
                {bill && bill.packaging_inr > 0 ? (
                  <BillRow label="Packaging" value={bill.packaging_inr} />
                ) : null}
                <div className="mt-1 flex items-center justify-between border-t border-[#e5e5e5] pt-1">
                  <span className="font-bold">{isAddMode ? 'Adding' : 'Total'}</span>
                  <span className="font-bold text-tan">
                    {bill ? `₹${bill.total_inr}` : 'Calculating…'}
                  </span>
                </div>
                {isAddMode ? (
                  <p className="mt-1 text-xs text-muted">
                    The order&rsquo;s new total is recalculated when you add.
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* Optional customer capture — skippable in one tap. Hidden in add
                mode: the customer belongs to the order already. */}
            {isAddMode ? null : showCustomer ? (
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
                  // Also asked (and focused) in the Collect-payment step — BILL-2.
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

            {/* Primary action. In add mode there is no payment step — the tab is
                settled once, later. */}
            {isAddMode ? (
              <>
                <button
                  type="button"
                  disabled={cart.length === 0 || submitting}
                  onClick={submitAddToOrder}
                  className="w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {cart.length === 0
                    ? 'Add items to continue'
                    : submitting
                      ? 'Adding…'
                      : `Add ${totalItems} item${totalItems === 1 ? '' : 's'} to #${formatOrderNumber(addToOrder.orderNumber)}`}
                </button>
                <a
                  href="/staff/tables"
                  className="text-center text-xs font-bold text-muted underline"
                >
                  Cancel
                </a>
              </>
            ) : (
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
            )}
          </div>
        </div>
      </div>

      {customizing ? (
        <PosCustomizeModal
          item={customizing}
          initialQty={pendingQty}
          onAdd={addLine}
          onClose={() => {
            setCustomizing(null);
            setPendingQty(1);
          }}
        />
      ) : null}

      {paymentOpen ? (
        <PosPaymentModal
          bill={bill}
          orderType={orderType}
          tableLabel={selectedTableLabel}
          itemCount={totalItems}
          // BILL-2: the settle step edits the SAME phone state as the customer
          // block above, so whichever one staff use, `placeOrder` bills the
          // number they actually typed.
          phone={custPhone}
          onPhoneChange={(value) => {
            setCustPhone(value);
            if (contactError) setContactError(null);
          }}
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

      {confirmation ? (
        <PosPlacementConfirmation
          confirmation={confirmation}
          resending={resending}
          onPrintBill={() =>
            window.open(printUrl(confirmation.orderId, 'receipt'), '_blank', 'noopener')
          }
          onResend={resendConfirmationBill}
          // The queue has no per-order deep link yet; a just-placed order is at
          // the top of the board.
          onOpenOrder={() => router.push('/staff')}
          onDismiss={() => {
            setConfirmation(null);
            focusBar();
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

// POS4-4 — what replaced the fire-and-forget toast. Deliberately NOT a modal:
// the POS behind it is already reset and the command bar already refocused, so
// this must never trap focus or autofocus anything — a staffer who just keeps
// typing the next order is the normal case, and it clears itself for them.
function PosPlacementConfirmation({
  confirmation,
  resending,
  onPrintBill,
  onResend,
  onOpenOrder,
  onDismiss,
}: {
  confirmation: PlacementConfirmation;
  resending: boolean;
  onPrintBill: () => void;
  onResend: () => void;
  onOpenOrder: () => void;
  onDismiss: () => void;
}) {
  const { numberLabel, totalInr, paidAs, changeDueInr, bill, canResend, note } = confirmation;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[60] w-[min(22rem,calc(100vw-2rem))] rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-xl"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-base font-bold text-charcoal">#{numberLabel} placed</p>
          <p className="text-sm text-charcoal">
            ₹{totalInr} · {paidAs ? `paid ${paidAs}` : 'unpaid — collect later'}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-mr-1 -mt-1 shrink-0 px-1 text-xl leading-none text-muted hover:text-charcoal"
        >
          &times;
        </button>
      </div>

      {/* The one number the counter must act on before anything else. */}
      {changeDueInr > 0 ? (
        <p className="mt-2 rounded-md bg-[#f6efe9] px-3 py-2 text-sm font-bold text-tan-dark">
          Change due <span className="text-lg">₹{changeDueInr}</span>
        </p>
      ) : null}

      {bill ? (
        <p className={'mt-2 text-xs font-bold ' + (bill.ok ? 'text-green-700' : 'text-red-700')}>
          {bill.message}
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted">The bill goes out when the order is settled.</p>
      )}

      {note ? <p className="mt-1 text-xs font-bold text-red-700">{note}</p> : null}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <ConfirmAction label="Print bill" onClick={onPrintBill} />
        {/* Nothing to resend to is not a button that fails — it's the reason
            shown above, which staff can still fix from the order. */}
        {canResend ? (
          <ConfirmAction label={resending ? 'Sending…' : 'Resend bill'} onClick={onResend} disabled={resending} />
        ) : null}
        <ConfirmAction label="Open order" onClick={onOpenOrder} />
        <ConfirmAction label="New order" onClick={onDismiss} primary />
      </div>
    </div>
  );
}

function ConfirmAction({
  label,
  onClick,
  disabled = false,
  primary = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'rounded-md px-3 py-2 text-xs font-bold transition-colors disabled:opacity-50 ' +
        (primary
          ? 'bg-tan text-cream hover:bg-tan-dark'
          : 'border border-[#e5e5e5] text-charcoal hover:border-tan hover:text-tan')
      }
    >
      {label}
    </button>
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
      <span className="mt-2 flex w-full items-center justify-between gap-1">
        <span className="text-xs font-bold text-tan">{priceLabel}</span>
        <span className="flex items-center gap-1">
          {item.short_code ? (
            <span className="rounded border border-[#e5e5e5] px-1 font-mono text-[10px] font-bold uppercase text-muted">
              {item.short_code}
            </span>
          ) : null}
          {!available ? <span className="text-[10px] font-bold text-muted">86’d</span> : null}
        </span>
      </span>
    </button>
  );
}
