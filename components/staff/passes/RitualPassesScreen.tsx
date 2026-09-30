'use client';

// "Ritual passes" (/staff/passes) — sell a HIOC Ritual at the counter and look
// after the ones customers already hold (docs/COFFEE-PASS-SPEC.md §8).
//
// Two columns on a landscape counter tablet (stacked below lg):
//   left   the customer: phone first (the field that finds the account), name,
//          then what they hold — cups left, valid till, history, Extend / Give
//          back a cup for a manager — and any Ritual they were sold but haven't
//          paid for yet, with Collect payment.
//   right  the plans on sale, each with Sell.
//
// Selling is two steps, deliberately: Sell creates the sale ORDER (unpaid, one
// line) after a confirm sheet, then the payment step is the SAME one Settle uses
// (SettlePaymentDialog: cash with change, UPI, card, a split) against that order.
// The pass is issued by the database the moment the order is paid (CP-D6), so a
// sale nobody pays for simply waits under "Unpaid Ritual sales" here and in
// Settle. Nothing on this screen decides a rupee: the plan price comes from the
// plan, the total charged from the order the server made.
//
// Everything is hidden while the flag is off (the page guards it, every API
// answers 404).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettlePaymentDialog } from '@/components/staff/SettlePaymentDialog';
import { CustomerSuggestionList, useCustomerNameSuggestions, useCustomerSuggestions } from '@/components/staff/CustomerPhoneSuggestions';
import { usePrintDock } from '@/components/staff/PrintDock';
import { AdjustPassDialog, type AdjustKind } from '@/components/staff/passes/AdjustPassDialog';
import { PassCard } from '@/components/staff/passes/PassCard';
import { PlanCard } from '@/components/staff/passes/PlanCard';
import { SellConfirmDialog, type CreatedSale } from '@/components/staff/passes/SellConfirmDialog';
import { useHolderLookup } from '@/components/staff/passes/useHolderLookup';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import type { OrderResponse } from '@/lib/api/orders';
import type { CustomerSuggestion } from '@/lib/customers/phoneSearch';
import { useCounterDefaults } from '@/lib/hooks/useCounterDefaults';
import { normalizeIndianMobile } from '@/lib/phone';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import type { CoffeePassPlan, PassSummary } from '@/lib/passes/types';
import { shouldAutofillName } from '@/lib/pos/nameAutofill';
import {
  MAX_SALE_NAME_LENGTH,
  saleActiveMessage,
  saleAttemptKey,
  salePaidFallbackMessage,
  sellBlockedReason,
  type HolderPass,
  type PlanGst,
  type RitualSale,
} from '@/lib/pos/ritual';
import { settlePrintPlan } from '@/lib/staff/autoPrint';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { Order, OrderItem } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

/** The sale order the API returns, in the shape the payment step takes (its lines carry their order id). */
function toSettleOrder(order: OrderResponse): OrderWithItems {
  return { ...order, items: order.items.map((item) => ({ ...item, order_id: order.id })) };
}

type PlansState =
  | { status: 'loading' }
  | { status: 'ready'; plans: CoffeePassPlan[]; gst: PlanGst | null }
  | { status: 'error'; message: string };

interface Notice {
  tone: 'success' | 'info' | 'warning';
  text: string;
  /** A paid sale's order, so its receipt can be printed from the banner. */
  receiptOrderId?: string;
}

const NOTICE_CLASS: Record<Notice['tone'], string> = {
  success: 'border-green-200 bg-green-100 text-green-900',
  info: 'border-line bg-surface text-charcoal',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
};

const SELL_REASON_ID = 'ritual-sell-reason';

export function RitualPassesScreen({
  initialPhone = '',
  canManage,
  canSell,
  sellBlockedMessage = null,
}: {
  /** From `?phone=` (the link on New order); digits only. */
  initialPhone?: string;
  /** May extend a pass or give cups back (`pass_manage`, default manager). The API is the real guard. */
  canManage: boolean;
  /** May sell here (`pass_sell`, and this screen may take orders). The API is the real guard. */
  canSell: boolean;
  /** Why not, when it may not. */
  sellBlockedMessage?: string | null;
}) {
  // --- The customer --------------------------------------------------------
  const [phone, setPhone] = useState(initialPhone);
  const [name, setName] = useState('');
  const lookupPhone = useMemo(() => normalizeIndianMobile(phone) ?? '', [phone]);
  const phoneDigits = phone.replace(/\D/g, '');
  const phoneLooksWrong = phoneDigits.length >= 10 && !lookupPhone;

  // Phone-first name autofill, the same rule as New order (lib/pos/nameAutofill):
  // a name that came from a lookup may be replaced by the next lookup; one the
  // cashier typed never is.
  const nameRef = useRef(name);
  nameRef.current = name;
  const nameUserEdited = useRef(false);
  const { state: holderState, nameHint, refresh: refreshHolder, patchPass } = useHolderLookup(lookupPhone);

  useEffect(() => {
    // A different number is a different person: an autofilled name goes with the old one.
    if (!nameUserEdited.current) setName('');
  }, [lookupPhone]);
  useEffect(() => {
    if (!nameHint) return;
    if (shouldAutofillName(nameRef.current, nameUserEdited.current)) {
      setName(nameHint);
      nameUserEdited.current = false;
    }
  }, [nameHint]);

  const [phoneSuggestOpen, setPhoneSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const phoneSuggestions = useCustomerSuggestions(phone);
  const shownSuggestions = phoneSuggestOpen ? phoneSuggestions : [];
  const pickSuggestion = useCallback((c: CustomerSuggestion) => {
    setPhone(c.phone);
    setPhoneSuggestOpen(false);
    setSuggestIndex(-1);
    nameInputRef.current?.focus();
  }, []);
  const [nameSuggestOpen, setNameSuggestOpen] = useState(false);
  const [nameSuggestIndex, setNameSuggestIndex] = useState(-1);
  const nameSuggestions = useCustomerNameSuggestions(name, !lookupPhone);
  const shownNameSuggestions = nameSuggestOpen ? nameSuggestions : [];
  const pickNameSuggestion = useCallback((c: CustomerSuggestion) => {
    setPhone(c.phone);
    setName(c.name);
    nameUserEdited.current = false;
    setNameSuggestOpen(false);
    setNameSuggestIndex(-1);
  }, []);

  // --- Plans ---------------------------------------------------------------
  const [plans, setPlans] = useState<PlansState>({ status: 'loading' });
  const loadPlans = useCallback(async () => {
    setPlans({ status: 'loading' });
    try {
      const res = await fetch('/api/passes/plans', { cache: 'no-store' });
      const data = (await res.json().catch(() => null)) as
        | { plans?: CoffeePassPlan[]; gst?: PlanGst; error?: string }
        | null;
      if (!res.ok || !data?.plans) {
        setPlans({ status: 'error', message: data?.error ?? 'Could not load the plans.' });
        return;
      }
      setPlans({ status: 'ready', plans: data.plans, gst: data.gst ?? null });
    } catch {
      setPlans({ status: 'error', message: 'Could not reach the server. Check the connection and try again.' });
    }
  }, []);
  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  // --- Selling and taking payment -------------------------------------------
  const printDock = usePrintDock();
  const { autoPrint } = useCounterDefaults();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selling, setSelling] = useState<CoffeePassPlan | null>(null);
  const [paying, setPaying] = useState<{ order: OrderWithItems; planName: string } | null>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);
  // One key per sale attempt (see SellConfirmDialog): kept until a sale exists.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const sellReason = sellBlockedReason({
    canSell,
    blockedMessage: sellBlockedMessage,
    phoneValid: Boolean(lookupPhone),
    name,
  });

  const holder = holderState.status === 'ready' ? holderState.holder : null;
  const unpaidSales: RitualSale[] = holder?.found ? holder.unpaid_sales : [];
  const heldPasses: HolderPass[] = holder?.found ? holder.passes : [];

  function openSell(plan: CoffeePassPlan) {
    if (sellReason) return;
    attempt.current = saleAttemptKey(attempt.current, `${lookupPhone}|${name.trim()}|${plan.id}`);
    setNotice(null);
    setSelling(plan);
  }

  /** A paid sale: say the Ritual is live (read back from the customer's own passes) and offer the receipt. */
  const announcePaid = useCallback(
    async (orderId: string, planName: string) => {
      const fresh = await refreshHolder();
      const issued = fresh?.found ? fresh.passes.find((p) => p.order_id === orderId) : undefined;
      setNotice(
        issued
          ? { tone: 'success', text: saleActiveMessage(issued), receiptOrderId: orderId }
          : { tone: 'warning', text: salePaidFallbackMessage(planName), receiptOrderId: orderId },
      );
    },
    [refreshHolder],
  );

  function handleCreated(sale: CreatedSale) {
    const plan = selling;
    attempt.current = null; // a sale exists: the next one is a new attempt
    setSelling(null);
    const order = sale.order;
    const planName = plan?.name ?? order.items[0]?.name_snapshot ?? PASS_PROGRAM_NAME;
    if (order.payment_status === 'paid') {
      // A replayed sale that was already paid: nothing to collect.
      void announcePaid(order.id, planName);
      return;
    }
    setPaying({ order: toSettleOrder(order), planName });
    // So the sale is on the customer's unpaid list at once if the payment step is closed.
    void refreshHolder();
  }

  function handlePaid() {
    if (!paying) return;
    const { order, planName } = paying;
    setPaying(null);
    // The same rule as settling anywhere else: a bill prints if this counter prints bills.
    const jobs = settlePrintPlan(autoPrint, { orderKind: 'coffee_pass' }).map((type) => ({ orderId: order.id, type }));
    if (jobs.length > 0) printDock.enqueue(jobs);
    void announcePaid(order.id, planName);
  }

  function handlePayClosed() {
    if (!paying) return;
    const { order } = paying;
    setPaying(null);
    setNotice({
      tone: 'warning',
      text: `Sale #${formatOrderNumber(order.order_number)} isn’t paid yet, so the ${PASS_PROGRAM_NAME} hasn’t started. It waits under Unpaid Ritual sales below, and in Settle — collect it any time.`,
    });
    void refreshHolder();
  }

  async function collect(sale: RitualSale) {
    if (collectingId) return;
    setCollectingId(sale.order_id);
    setCollectError(null);
    try {
      const res = await fetch(`/api/orders/${sale.order_id}`, { cache: 'no-store' });
      const data = (await res.json().catch(() => null)) as { order?: OrderResponse; error?: string } | null;
      if (!res.ok || !data?.order) {
        setCollectError(data?.error ?? 'Could not open that sale. Try again.');
        return;
      }
      if (data.order.payment_status === 'paid') {
        // Paid elsewhere since the list was read (Settle, another counter).
        void announcePaid(data.order.id, sale.plan_name);
        return;
      }
      setPaying({ order: toSettleOrder(data.order), planName: sale.plan_name });
    } catch {
      setCollectError('Could not reach the server. Check the connection and try again.');
    } finally {
      setCollectingId(null);
    }
  }

  // --- Manager actions -------------------------------------------------------
  const [adjusting, setAdjusting] = useState<{ pass: HolderPass; kind: AdjustKind } | null>(null);
  function handleAdjusted(pass: PassSummary, message: string) {
    setAdjusting(null);
    patchPass(pass);
    setNotice({ tone: 'success', text: message });
    void refreshHolder();
  }

  // --- Render ----------------------------------------------------------------
  const suggestionsId = 'ritual-phone-suggestions';
  const nameSuggestionsId = 'ritual-name-suggestions';

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-charcoal">Ritual passes</h1>
        <p className="text-sm text-muted">
          Sell a {PASS_PROGRAM_NAME} and see what a customer holds. Cups are used from New order.
        </p>
      </header>

      {/* Announced as it changes; kept mounted so a screen reader hears the first one. */}
      <div role="status" aria-live="polite">
        {notice ? (
          <div className={'mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm font-bold ' + NOTICE_CLASS[notice.tone]}>
            <span className="min-w-0">{notice.text}</span>
            <span className="flex shrink-0 flex-wrap gap-2">
              {notice.receiptOrderId ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => printDock.enqueue([{ orderId: notice.receiptOrderId as string, type: 'receipt' }])}
                >
                  Print receipt
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            </span>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        {/* ---- The customer ---- */}
        <section aria-labelledby="ritual-customer-heading" className="flex min-w-0 flex-col gap-4">
          <Card>
            <h2 id="ritual-customer-heading" className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">
              Customer
            </h2>
            <div className="flex flex-col gap-3">
              <div className="relative">
                <Input
                  label="Mobile number"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus={!initialPhone}
                  placeholder="10-digit mobile number"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setPhoneSuggestOpen(true);
                    setSuggestIndex(-1);
                  }}
                  onFocus={() => setPhoneSuggestOpen(true)}
                  onBlur={() => setPhoneSuggestOpen(false)}
                  onKeyDown={(e) => {
                    // Suggestions: arrows move, Enter picks, Escape closes.
                    if (shownSuggestions.length > 0) {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const step = e.key === 'ArrowDown' ? 1 : -1;
                        setSuggestIndex((i) => (i + step + shownSuggestions.length) % shownSuggestions.length);
                        return;
                      }
                      if (e.key === 'Escape') {
                        setPhoneSuggestOpen(false);
                        return;
                      }
                      if (e.key === 'Enter' && suggestIndex >= 0) {
                        e.preventDefault();
                        pickSuggestion(shownSuggestions[suggestIndex]);
                        return;
                      }
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      nameInputRef.current?.focus();
                    }
                  }}
                  aria-autocomplete="list"
                  aria-controls={suggestionsId}
                  error={phoneLooksWrong ? 'Enter a valid 10-digit Indian mobile number.' : undefined}
                />
                <CustomerSuggestionList id={suggestionsId} matches={shownSuggestions} highlighted={suggestIndex} onPick={pickSuggestion} />
              </div>

              <div className="relative">
                <Input
                  ref={nameInputRef}
                  label="Name"
                  type="text"
                  autoComplete="off"
                  maxLength={MAX_SALE_NAME_LENGTH}
                  placeholder="Name (type to search)"
                  value={name}
                  onChange={(e) => {
                    nameUserEdited.current = true;
                    setName(e.target.value);
                    setNameSuggestOpen(true);
                    setNameSuggestIndex(-1);
                  }}
                  onFocus={() => setNameSuggestOpen(true)}
                  onBlur={() => setNameSuggestOpen(false)}
                  onKeyDown={(e) => {
                    if (shownNameSuggestions.length === 0) return;
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const step = e.key === 'ArrowDown' ? 1 : -1;
                      setNameSuggestIndex((i) => (i + step + shownNameSuggestions.length) % shownNameSuggestions.length);
                    } else if (e.key === 'Escape') {
                      setNameSuggestOpen(false);
                    } else if (e.key === 'Enter' && nameSuggestIndex >= 0) {
                      e.preventDefault();
                      pickNameSuggestion(shownNameSuggestions[nameSuggestIndex]);
                    }
                  }}
                  aria-autocomplete="list"
                  aria-controls={nameSuggestionsId}
                  hint="The account is opened under this name if the number has none yet."
                />
                <CustomerSuggestionList
                  id={nameSuggestionsId}
                  matches={shownNameSuggestions}
                  highlighted={nameSuggestIndex}
                  onPick={pickNameSuggestion}
                />
              </div>
            </div>
          </Card>

          {/* ---- What they hold ---- */}
          <div aria-busy={holderState.status === 'loading'}>
            {holderState.status === 'idle' ? (
              <p className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
                Enter the customer&rsquo;s mobile number to see their {PASS_PROGRAM_NAME}.
              </p>
            ) : holderState.status === 'loading' ? (
              <div className="flex flex-col gap-3" role="status" aria-label="Loading the customer’s passes">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : holderState.status === 'error' ? (
              <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <p className="font-bold">{holderState.message}</p>
                <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void refreshHolder()}>
                  Try again
                </Button>
              </div>
            ) : holder && !holder.found ? (
              <EmptyState
                icon="☕"
                heading="No HIOC account on this number yet"
                body={`Selling a ${PASS_PROGRAM_NAME} opens one under the name above.`}
              />
            ) : holder?.found ? (
              <div className="flex flex-col gap-4">
                <div>
                  <h2 className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm font-bold uppercase tracking-wide text-muted">
                    <span>{PASS_PROGRAM_NAME} passes</span>
                    {holder.name ? <span className="text-xs font-normal normal-case text-muted">{holder.name}</span> : null}
                  </h2>
                  {heldPasses.length === 0 ? (
                    <EmptyState
                      icon="☕"
                      heading={`No ${PASS_PROGRAM_NAME} yet`}
                      body="Pick a plan on the right to sell them one."
                    />
                  ) : (
                    <ul className="flex flex-col gap-3">
                      {heldPasses.map((pass) => (
                        <PassCard
                          key={pass.id}
                          pass={pass}
                          canManage={canManage}
                          onExtend={(p) => setAdjusting({ pass: p, kind: 'extend' })}
                          onGiveBack={(p) => setAdjusting({ pass: p, kind: 'credit' })}
                        />
                      ))}
                    </ul>
                  )}
                  {!canManage && heldPasses.length > 0 ? (
                    <p className="mt-2 text-xs text-muted">A manager can extend a {PASS_PROGRAM_NAME} or give a cup back.</p>
                  ) : null}
                </div>

                {unpaidSales.length > 0 ? (
                  <div>
                    <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">
                      Unpaid {PASS_PROGRAM_NAME} sales
                    </h2>
                    <ul className="flex flex-col gap-2">
                      {unpaidSales.map((sale) => (
                        <li
                          key={sale.order_id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 border-l-4 border-l-red-500 bg-white px-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-charcoal">
                              {sale.plan_name || `${PASS_PROGRAM_NAME} sale`}
                              {sale.order_number != null ? (
                                <span className="ml-2 font-mono text-xs font-normal tabular-nums text-muted">
                                  #{formatOrderNumber(sale.order_number)}
                                </span>
                              ) : null}
                            </p>
                            <p className="text-xs text-muted">Not paid, so the Ritual hasn&rsquo;t started.</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-lg font-bold tabular-nums text-red-800">₹{sale.total_inr}</span>
                            <Button
                              type="button"
                              size="sm"
                              loading={collectingId === sale.order_id}
                              disabled={collectingId !== null}
                              onClick={() => void collect(sale)}
                            >
                              Collect payment
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {collectError ? (
                      <p role="alert" className="mt-2 text-sm font-bold text-red-800">
                        {collectError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        {/* ---- The plans ---- */}
        <section aria-labelledby="ritual-plans-heading" className="flex min-w-0 flex-col gap-3">
          <h2 id="ritual-plans-heading" className="text-sm font-bold uppercase tracking-wide text-muted">
            Plans
          </h2>
          {sellReason ? (
            <p id={SELL_REASON_ID} className="rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
              {sellReason}
            </p>
          ) : null}

          {plans.status === 'loading' ? (
            <div className="flex flex-col gap-3" role="status" aria-label="Loading the plans">
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-44 w-full" />
            </div>
          ) : plans.status === 'error' ? (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-bold">{plans.message}</p>
              <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void loadPlans()}>
                Try again
              </Button>
            </div>
          ) : plans.plans.length === 0 ? (
            <EmptyState
              icon="☕"
              heading={`No ${PASS_PROGRAM_NAME} plans on sale`}
              body="The owner switches plans on under Owner → Passes."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {plans.plans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  gst={plans.gst}
                  sellBlocked={sellReason !== null}
                  blockedReasonId={SELL_REASON_ID}
                  onSell={openSell}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {selling && plans.status === 'ready' ? (
        <SellConfirmDialog
          plan={selling}
          gst={plans.gst}
          customerName={name}
          phone={lookupPhone}
          idempotencyKey={attempt.current?.key ?? ''}
          unpaidSame={unpaidSales.find((s) => s.plan_name === selling.name) ?? null}
          onCancel={() => setSelling(null)}
          onCreated={handleCreated}
        />
      ) : null}

      {paying ? (
        <SettlePaymentDialog order={paying.order} intent="settle" onClose={handlePayClosed} onDone={handlePaid} />
      ) : null}

      {adjusting ? (
        <AdjustPassDialog
          pass={adjusting.pass}
          kind={adjusting.kind}
          onClose={() => setAdjusting(null)}
          onDone={handleAdjusted}
        />
      ) : null}

      {printDock.node}
    </div>
  );
}
