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
//
// FLOW-1/PRT-1 (Phase 6) — the two ways this screen used to change underneath
// the staffer are gone: payment is a panel docked in the order pane rather than
// a modal over it (behind NEXT_PUBLIC_FLAG_POS_V2, modal until Gate 6B), and
// printing happens in a hidden iframe rather than a foreground tab.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MenuCategoryTabs } from '@/components/menu/MenuCategoryTabs';
import { PosCustomizeModal } from '@/components/staff/PosCustomizeModal';
import { PosPaymentModal, PosPaymentPanel } from '@/components/staff/PosPaymentModal';
import { PosQuickAddBar } from '@/components/staff/PosQuickAddBar';
import { Spinner } from '@/components/ui/Spinner';
import { flags } from '@/lib/flags';
import { createClient } from '@/lib/supabase';
import { isSimpleItem, parseQuickAddInput, resolveQuickAdd } from '@/lib/pos/quickAdd';
import { usePrintDock } from '@/components/staff/PrintDock';
import { pushRecent, readRecents } from '@/lib/pos/recents';
import { computeCartKey } from '@/lib/cart/cartKey';
import type { CartItem } from '@/lib/cart/CartContext';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { useMenuAvailabilityRealtime } from '@/lib/realtime/hooks';
import { normalizeIndianMobile } from '@/lib/phone';
import { normalizeEmail } from '@/lib/email';
import {
  canRedeemPoints,
  couponFeedback,
  describeCustomer,
  parsePointsInput,
  pointsFeedback,
  type CustomerLookup,
  type QuotedDiscount,
} from '@/lib/pos/loyalty';
import type { PaymentPart } from '@/lib/orders/payments';
import { placementPrintPlan, type PrintType } from '@/lib/staff/autoPrint';
import { useCounterDefaults } from '@/lib/hooks/useCounterDefaults';
import { POS_FALLBACK_ORDER_TYPE, resolveDefaultOrderType } from '@/lib/pos/deviceSettings';
import {
  billStatusFromDelivery,
  billStatusTone,
  describePaymentParts,
  parseResendResult,
  placementBillStatus,
  type BillDeliveryRow,
  type BillStatusView,
} from '@/lib/staff/confirmation';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { MENU_CATEGORIES } from '@/lib/constants';
import type { BillBreakdown } from '@/lib/store/hours';
import type { MenuItem, OrderType } from '@/lib/types';

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
  /**
   * Where `bill` came from. The delivery poll reads a `notifications` row that a
   * failed resend never touched — a 429, a dropped connection or a 401 all
   * return before the engine runs — so the row still says 'sent' from the
   * placement send. Without provenance the poll's stale success lands on top of
   * the fresh failure and the staffer reads "Bill sent on WhatsApp" one
   * round-trip after "Too many bill resends for this order".
   */
  billFrom: 'placement' | 'poll' | 'action';
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

// PRT-1 deleted openBlankPrintWindow() and the whole pop-up dance with it. It
// opened one foreground tab per queued print INSIDE the click handler (the only
// moment a browser allows it) and pointed it at the print page once the order
// had an id — which is why the counter's screen jumped to a blank tab the
// instant they took the money, then to a receipt firing a print dialog, and why
// those tabs piled up in Chrome's restored session. Prints now run in a hidden
// same-origin iframe (see the print queue below): no tab, no focus change,
// nothing for a pop-up blocker to have an opinion about.

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
  const [orderType, setOrderType] = useState<OrderType>(POS_FALLBACK_ORDER_TYPE);
  // DEV-3 — set the moment a staffer picks a type themselves. The device
  // default may only seed this control, never overrule a person who already
  // answered: the boot fetch resolves a beat after first paint, and snapping
  // "Takeaway" back to the machine's default under someone's finger is the same
  // class of bug as the payment screen taking over mid-order.
  const orderTypeTouched = useRef(false);

  const [tables, setTables] = useState<StaffTable[]>([]);
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableFilter, setTableFilter] = useState(''); // POS4-5, shown past ~12 tables

  const [showCustomer, setShowCustomer] = useState(false);
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [contactError, setContactError] = useState<string | null>(null);

  // VAL-1/VAL-2 — the customer behind the phone, and what they're spending.
  // `couponCode` is what has actually been APPLIED (and therefore quoted);
  // `couponInput` is what's being typed. Quoting every keystroke would tell a
  // staffer "Invalid coupon code" three times while they type a valid one.
  const [customer, setCustomer] = useState<CustomerLookup | null>(null);
  const [couponInput, setCouponInput] = useState('');
  const [couponCode, setCouponCode] = useState('');
  const [pointsInput, setPointsInput] = useState('');
  const [quotedCoupon, setQuotedCoupon] = useState<QuotedDiscount | null>(null);
  const [quotedPoints, setQuotedPoints] = useState<QuotedDiscount | null>(null);

  const [bill, setBill] = useState<BillBreakdown | null>(null);
  const [customizing, setCustomizing] = useState<MenuItem | null>(null);
  const [pendingQty, setPendingQty] = useState(1); // qty carried from "3*latte" into the modal
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]); // "Quick picks" (this tablet)
  // POS4-3/4 + DEV-3 — the close of the counter loop. What prints is the
  // enrolled machine's answer if it has one, else the store's, else the
  // documented default; `device` is also how this screen learns which till it
  // is running on.
  const { autoPrint, device: posDevice, ready: defaultsReady } = useCounterDefaults();
  const [confirmation, setConfirmation] = useState<PlacementConfirmation | null>(null);
  const [resending, setResending] = useState(false);

  // PRT-1/PRT-3 — the print pipeline, shared with the order board
  // (components/staff/PrintDock). One hidden iframe at a time: two
  // window.print() calls in flight race inside the browser and one of them
  // silently does nothing, which on a KOT+receipt order means the kitchen gets
  // no ticket. The dock owns the queue, the ordering, the 10s watchdog, the
  // failure chip and the retry.
  const printDock = usePrintDock();

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

  // DEV-3 — seed the order-type toggle from the machine's default, ONCE.
  //
  // Skipped entirely when the URL named a table (arriving from the tables board
  // means dine-in at that table, and a device that prefers takeaway does not get
  // to contradict a tap that just happened) and in add-mode, where the type
  // belongs to the order already on the rail.
  const appliedDeviceType = useRef(false);
  useEffect(() => {
    if (appliedDeviceType.current || !defaultsReady) return;
    appliedDeviceType.current = true;
    if (isAddMode || initialTableId || orderTypeTouched.current) return;
    setOrderType(resolveDefaultOrderType(posDevice));
  }, [defaultsReady, posDevice, isAddMode, initialTableId]);

  // POS4-4 — the confirmation is a report, not a gate: it clears itself so a
  // staffer already punching the next order never has to dismiss it. Any action
  // taken on it replaces the object, which restarts this timer — someone still
  // reading it doesn't lose it mid-tap.
  useEffect(() => {
    if (!confirmation) return;
    const t = setTimeout(() => setConfirmation(null), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmation]);

  // WA-5 — what the delivery log actually says about this order's bill. The
  // settle route fires the bill (BILL-1) but answers with the order and the
  // change due only, so the strip's first line is an honest "sending…"; this
  // replaces it with the engine's own per-channel verdict (sent / failed / the
  // exact skip reason) and, once Meta's status webhook has run (WA-4), with
  // 'delivered' — the only word that means the customer has their bill.
  // Best-effort by design: `notifications` is staff-readable, and a read that
  // fails leaves the honest "sending…" rather than inventing a success.
  // Keyed on the ORDER only. It used to depend on `confirmation.bill.state` too,
  // which restarted the whole effect — and its 3-poll budget — on every rung, so
  // "3 looks while the strip is up" was really up to 9. Worse, the state change
  // a failed resend produces re-ran it immediately, which is how the stale row
  // got a second chance to overwrite the failure. The live state is read through
  // a ref instead, so the poll can stop without being able to restart itself.
  const confirmationRef = useRef<PlacementConfirmation | null>(null);
  confirmationRef.current = confirmation;

  useEffect(() => {
    const orderId = confirmation?.orderId;
    if (!orderId || !confirmation?.bill) return;

    let cancelled = false;
    let attempts = 0;
    const supabase = createClient();

    const read = async () => {
      attempts += 1;
      const cur = confirmationRef.current;
      // Nothing left to learn: the handset confirmed it, or there was never
      // anything to send.
      if (!cur || cur.orderId !== orderId) return;
      if (cur.bill?.state === 'delivered' || cur.bill?.state === 'none') return;
      try {
        const { data, error } = await supabase
          .from('notifications')
          .select('channel, status, skip_reason, error')
          .eq('order_id', orderId)
          .eq('event', 'bill');
        if (cancelled || error || !data) return;
        const view = billStatusFromDelivery(data as BillDeliveryRow[]);
        if (!view) return;
        setConfirmation((prev) => {
          if (!prev || prev.orderId !== orderId) return prev;
          // The staffer just pressed Resend and got an answer. That answer is
          // about THIS moment; the log row may not have been written by it at
          // all (a 429 or a network drop never reaches the engine). Only
          // evidence from the customer's handset is allowed to replace it.
          if (prev.billFrom === 'action' && view.state !== 'delivered') return prev;
          // Same verdict → same object, or every poll would restart the
          // confirmation's own auto-clear timer and it would never go away.
          if (prev.bill && prev.bill.state === view.state && prev.bill.message === view.message) {
            return prev;
          }
          return { ...prev, bill: view, billFrom: 'poll' };
        });
      } catch {
        /* the counter keeps the honest "sending…" line */
      }
    };

    void read();
    const t = setInterval(() => {
      // A handful of looks while the strip is up; the webhook's 'delivered'
      // usually lands within a few seconds, and the strip is gone at 12.
      if (attempts >= 3) {
        clearInterval(t);
        return;
      }
      void read();
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmation?.orderId]);

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

  // Points the staffer has asked to burn. Parsed, never trusted as money — the
  // rupee value comes back from the quote.
  const redeemPoints = useMemo(() => parsePointsInput(pointsInput), [pointsInput]);
  // Only a phone that could actually be someone is worth a lookup or a quote.
  const lookupPhone = useMemo(() => normalizeIndianMobile(custPhone) ?? '', [custPhone]);

  // --- VAL-2: who is at the counter ----------------------------------------
  // Runs off the phone alone, and the result is a name the staffer can check
  // against the person in front of them BEFORE any of their points are spent —
  // the mistyped-digit guard the ticket asks for. The endpoint returns a name
  // and a balance and nothing else, so nothing further about them can leak here.
  useEffect(() => {
    if (isAddMode || !lookupPhone) {
      setCustomer(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/customers/lookup?phone=${lookupPhone}`, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: CustomerLookup | null) => {
          if (!cancelled) setCustomer(data ?? null);
        })
        .catch(() => {});
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [lookupPhone, isAddMode]);

  // A number that stops matching an account can't keep its points quoted.
  useEffect(() => {
    if (!canRedeemPoints(customer)) {
      setPointsInput('');
      setQuotedPoints(null);
    }
  }, [customer]);

  // --- Live bill from the quote endpoint (never computed client-side) -------
  // VAL-1: the coupon and the points ride along, so the discount lines shown
  // here are the server's own arithmetic — the same call the web checkout makes,
  // plus the phone, which the server (not this client) turns into the account
  // whose points are being spent.
  // FLOW-1: true from the instant a priced input changes until the matching
  // quote lands. Docked, the menu grid stays tappable while the payment step is
  // open, so without this the panel spends every re-quote window offering to
  // take the PREVIOUS cart's total. Set synchronously (not inside the 250 ms
  // debounce) because the gap it has to cover starts at the tap, not at the
  // fetch.
  const [billStale, setBillStale] = useState(false);

  useEffect(() => {
    if (subtotal <= 0) {
      setBill(null);
      setQuotedCoupon(null);
      setQuotedPoints(null);
      setBillStale(false);
      return;
    }
    let cancelled = false;
    setBillStale(true);
    // Small debounce so rapid qty taps don't fire a burst of quotes.
    const t = setTimeout(() => {
      fetch('/api/orders/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtotal_inr: subtotal,
          order_type: orderType,
          item_ids: cartRef.current.map((i) => i.menuItemId),
          ...(couponCode ? { coupon_code: couponCode } : {}),
          ...(redeemPoints > 0 ? { redeem_points: redeemPoints } : {}),
          ...(lookupPhone ? { customer_phone: lookupPhone } : {}),
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { bill?: BillBreakdown; coupon?: QuotedDiscount | null; points?: QuotedDiscount | null } | null) => {
          if (cancelled || !data?.bill) return;
          setBill(data.bill);
          setQuotedCoupon(couponCode ? (data.coupon ?? null) : null);
          setQuotedPoints(redeemPoints > 0 ? (data.points ?? null) : null);
          // Only now do the numbers on screen describe the cart on screen.
          setBillStale(false);
        })
        // A failed quote leaves `billStale` true on purpose: the panel keeps
        // saying "re-pricing" rather than offering to charge a total nobody
        // re-confirmed.
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [subtotal, orderType, couponCode, redeemPoints, lookupPhone]);

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

  // PRT-1/PRT-3 — the only way anything prints from this screen. What prints
  // when is still lib/staff/autoPrint's decision (unchanged); this is purely the
  // execution.
  const enqueuePrints = useCallback(
    (orderId: string, types: PrintType[]) => {
      printDock.enqueue(types.map((type) => ({ orderId, type })));
    },
    [printDock],
  );

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

  // FLOW-1 — where the payment step lives. Docked, it takes the place of the
  // Charge button at the bottom of the order pane, so the menu grid stays
  // visible and tappable and the cart above it never disappears behind an
  // overlay; the takeover modal is the pre-V2 path, kept until Gate 6B.
  // `canProceed` guards it because emptying the cart mid-payment leaves nothing
  // to charge for — the step folds back to the button rather than offering to
  // settle an empty order.
  const paymentDocked = flags.posV2 && !isAddMode;
  const showDockedPayment = paymentDocked && paymentOpen && canProceed;

  // --- Create (+ optionally settle) -----------------------------------------
  // POS4-1: settlement arrives as PARTS (a single-method payment is just one
  // part), so cash tendered and splits persist truthfully in order_payments and
  // the cash day counts only the cash that actually entered the drawer.
  async function placeOrder(parts: PaymentPart[] | null) {
    // Double-submit guard: the ref blocks a second entry even before the
    // `submitting` state has flushed to disable the buttons.
    if (inFlight.current) return;
    if (!canProceed) return;
    // FLOW-1: `parts` were sized against `bill`. If the cart has moved since,
    // those amounts are for a different order and the server's exact-sum
    // validator will reject them — after the cash is already in the drawer.
    // Creating the order UNPAID (parts === null) quotes nothing, so it is safe.
    if (parts && billStale) return;

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

      // VAL-1: only what the server has already AGREED to. The bill on screen
      // excludes a refused coupon, so sending it anyway would fail the whole
      // order at the till over something the staffer was told about minutes ago.
      // The account whose points these are is resolved server-side from the
      // phone above — this client never names it.
      if (couponCode && quotedCoupon?.ok) body.coupon_code = couponCode;
      if (redeemPoints > 0 && quotedPoints?.ok) body.redeem_points = redeemPoints;

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
          // kitchen still gets its ticket; no receipt is printed, since nothing
          // was actually paid (the print plan below reads `settled`).
          note = 'Payment not recorded — settle it from Orders.';
        }
      }

      // PRT-1 — queued AFTER the settle is known, because an unsettled order has
      // no bill to print (the plan already says so) and, unlike the old pop-up
      // path, nothing here needs to happen inside the staffer's tap. Success is
      // silent; a job that doesn't report back within 10s raises the chip.
      enqueuePrints(order.id, placementPrintPlan(autoPrint, { settled }));

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
        billFrom: 'placement',
        // Only offer a resend where a bill both exists and has somewhere to go.
        // A button that can only fail is the false-success this phase removes.
        canResend: settled && Boolean(phoneAtPlacement || emailAtPlacement),
        note,
      });
    } catch {
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
      setConfirmation((cur) =>
        cur && cur.orderId === target.orderId ? { ...cur, bill: result, billFrom: 'action' } : cur,
      );
    } catch {
      setConfirmation((cur) =>
        cur && cur.orderId === target.orderId
          ? {
              ...cur,
              bill: {
                state: 'failed',
                ok: false,
                message: 'Network error — please try again.',
                failedChannels: [],
              },
              billFrom: 'action',
            }
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
    // The next customer is a different person with a different balance —
    // carrying any of this over would spend the last one's points.
    setCustomer(null);
    setCouponInput('');
    setCouponCode('');
    setPointsInput('');
    setQuotedCoupon(null);
    setQuotedPoints(null);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000);
  }

  // A coupon takes effect on Apply, not on keystroke — see the couponCode state.
  function applyCoupon() {
    const code = couponInput.trim().toUpperCase();
    if (code) setCouponCode(code);
  }

  function clearCoupon() {
    setCouponInput('');
    setCouponCode('');
    setQuotedCoupon(null);
  }

  const displaySubtotal = bill?.subtotal_inr ?? subtotal;
  // Every one of these is the server's own verdict, rendered — not re-judged.
  const customerNote = describeCustomer(customer);
  const couponNote = couponFeedback(quotedCoupon);
  const pointsNote = pointsFeedback(quotedPoints);
  const pointsAvailable = canRedeemPoints(customer);

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
                    orderTypeTouched.current = true;
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
                {/* VAL-1: the coupon + points discount, exactly as the server
                    computed it. Nothing here is worked out on this tablet. */}
                {bill && bill.discount_inr > 0 ? (
                  <BillRow label="Discount" value={-bill.discount_inr} />
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
                {/* VAL-2: the matched name, so a mistyped digit is caught by a
                    human before it spends someone else's points. */}
                {customerNote ? (
                  <p className={'-mt-1 text-xs ' + (customerNote.ok ? 'font-bold text-green-700' : 'text-muted')}>
                    {customerNote.text}
                  </p>
                ) : null}
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

            {/* VAL-1 — the same coupon and points the customer would get on the
                web. Every rupee they're worth comes back from the quote; this
                panel only decides what to ASK for. */}
            {!isAddMode && cart.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-md border border-[#e5e5e5] px-3 py-2">
                <p className="text-xs font-bold uppercase tracking-wide text-muted">
                  Coupon &amp; points
                </p>

                <div className="flex gap-2">
                  <input
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        applyCoupon();
                      }
                    }}
                    disabled={couponCode.length > 0}
                    placeholder="Coupon code"
                    className="min-w-0 flex-1 rounded-md border border-[#e5e5e5] px-3 py-2 text-sm uppercase outline-none focus:border-tan disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={couponCode ? clearCoupon : applyCoupon}
                    disabled={!couponCode && couponInput.trim().length === 0}
                    className="shrink-0 rounded-md border border-[#e5e5e5] px-3 py-2 text-xs font-bold text-charcoal transition-colors hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {couponCode ? 'Clear' : 'Apply'}
                  </button>
                </div>
                {/* The server's own reason, verbatim — a friendlier local
                    rewording would eventually contradict what create enforces. */}
                {couponNote ? (
                  <p className={'text-xs ' + (couponNote.ok ? 'font-bold text-green-700' : 'text-red-700')}>
                    {couponNote.text}
                  </p>
                ) : null}

                {pointsAvailable && customerNote ? (
                  <>
                    <p className="text-xs font-bold text-green-700">{customerNote.text}</p>
                    <input
                      value={pointsInput}
                      onChange={(e) => setPointsInput(e.target.value.replace(/[^0-9]/g, ''))}
                      inputMode="numeric"
                      placeholder="Points to redeem"
                      className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-sm outline-none focus:border-tan"
                    />
                    {pointsNote ? (
                      <p className={'text-xs ' + (pointsNote.ok ? 'font-bold text-green-700' : 'text-red-700')}>
                        {pointsNote.text}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted">
                    {customer?.found
                      ? 'No points on this account yet.'
                      : 'Add the customer’s phone to use their points.'}
                  </p>
                )}
              </div>
            ) : null}

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
            ) : showDockedPayment ? (
              /* FLOW-1 — the payment step, docked. Same component as the modal
                 path renders, so cash tendered/change and the split rules (whose
                 parts must sum exactly to the server's total) are the very same
                 code, not a second copy of them. */
              <div className="rounded-md border border-tan bg-[#fdfaf7] p-3">
                <PosPaymentPanel
                  docked
                  // FLOW-1's guardrail: "the docked panel renders only quoted
                  // amounts". The menu stays tappable behind this panel, so
                  // this is the only thing standing between a mid-quote tap and
                  // a settle for the wrong total.
                  stale={billStale}
                  bill={bill}
                  orderType={orderType}
                  tableLabel={selectedTableLabel}
                  itemCount={totalItems}
                  phone={custPhone}
                  onPhoneChange={(value) => {
                    setCustPhone(value);
                    if (contactError) setContactError(null);
                  }}
                  customerNote={customerNote}
                  submitting={submitting}
                  error={submitError}
                  onSubmit={placeOrder}
                  onClose={() => {
                    if (!submitting) {
                      setPaymentOpen(false);
                      setSubmitError(null);
                      focusBar();
                    }
                  }}
                />
              </div>
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

      {paymentOpen && !paymentDocked ? (
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
          customerNote={customerNote}
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
          // PRT-1: through the same hidden pipeline as auto-print. A staffer who
          // asks for the bill wants paper, not a tab.
          onPrintBill={() => enqueuePrints(confirmation.orderId, ['receipt'])}
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

      {printDock.node}

      {toast ? (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-md bg-charcoal px-4 py-2 text-sm text-cream shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

const BILL_TONE_CLASS: Record<'good' | 'wait' | 'bad', string> = {
  good: 'text-green-700',
  wait: 'text-charcoal',
  bad: 'text-red-700',
};

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
  const billFailed = bill !== null && billStatusTone(bill) === 'bad';

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

      {/* WA-5 — three tones, because delivery has three answers. Green is only
          for a bill the handset acknowledged; a send still in flight is neither
          a promise nor an apology, and the staffer's cue is to wait rather than
          read the total out loud. */}
      {bill ? (
        <p className={'mt-2 text-xs font-bold ' + BILL_TONE_CLASS[billStatusTone(bill)]}>
          {bill.message}
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted">The bill goes out when the order is settled.</p>
      )}

      {note ? <p className="mt-1 text-xs font-bold text-red-700">{note}</p> : null}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <ConfirmAction label="Print bill" onClick={onPrintBill} />
        {/* Nothing to resend to is not a button that fails — it's the reason
            shown above, which staff can still fix from the order. A bill that
            DID fail makes this the primary action: the customer is still
            standing there, and one tap is the difference between trust and an
            apology. */}
        {canResend ? (
          <ConfirmAction
            label={resending ? 'Sending…' : 'Resend bill'}
            onClick={onResend}
            disabled={resending}
            primary={billFailed}
          />
        ) : null}
        <ConfirmAction label="Open order" onClick={onOpenOrder} />
        <ConfirmAction label="New order" onClick={onDismiss} primary={!billFailed} />
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
