'use client';

// The Pay step (docs/SHOP-V2-SPEC.md E2, E5, E7, E8). The bill, in this order:
// Subtotal, Introductory offer OR Coupon (with the note that says which was
// taken), Beanies, Shipping (or Free), Total. Then the Beanies toggle, "Have a
// code?" and the delivery note. The Pay button itself lives in the sticky bar
// (the page's one primary action).
//
// Everything shown comes from the quote (the server's when it has arrived; see
// lib/shop/useShopQuote.ts). The Beanies row follows E5 by `quote.beanies.state`:
//   applied / available_off  toggle "Use 39 Beanies: −₹39 (up to 5% on repeat orders)",
//                            on by default, balance after the order under it
//   below_min                "You have 12 Beanies. Use them from 20"
//   first_order              "Earn ~N Beanies on this order and save up to 5% next time"
//   guest                    the same line, led by a "Sign in to" link
//   unavailable              nothing
// The total is aria-live, so a change is announced.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { DELIVERY_TAKES, DISPATCH_WITHIN, lineItemLabel } from '@/lib/shop/catalog';
import { couponBlockedMessage } from '@/lib/shop/checkoutFlow';
import { rupees, type ShopQuoteV2 } from '@/lib/shop/pricing';

function Row({ label, children, strong = false }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? 'border-t border-line pt-3 text-base font-bold' : ''}`}>
      <dt className="text-charcoal">{label}</dt>
      <dd className="font-mono tabular-nums text-charcoal">{children}</dd>
    </div>
  );
}

function Saving({ children }: { children: ReactNode }) {
  return <span className="text-green-800">−{children}</span>;
}

export function PayStep({
  quote,
  loading,
  quoteError,
  cartProblem,
  couponError,
  couponBlocked,
  appliedCode,
  onApplyCode,
  onRemoveCode,
  useBeanies,
  onToggleBeanies,
  signedIn,
  priceNote,
  paymentReady,
  deliveryRecap,
  deliverySlot,
}: {
  quote: ShopQuoteV2 | null;
  loading: boolean;
  quoteError: string | null;
  cartProblem: string | null;
  couponError: string | null;
  /** The applied code was refused by the server: Pay is held until it is removed. */
  couponBlocked: boolean;
  appliedCode: string | null;
  onApplyCode: (code: string) => void;
  onRemoveCode: () => void;
  useBeanies: boolean;
  onToggleBeanies: (v: boolean) => void;
  signedIn: boolean;
  /** "Prices changed: here's the new total" and the like, after a 409. */
  priceNote: string | null;
  paymentReady: boolean;
  /** A typed address (form mode): one line with a Change link back to Deliver to. */
  deliveryRecap: { text: string; onChange: () => void } | null;
  /** The saved-address summary card (DeliverToStep compact). */
  deliverySlot: ReactNode;
}) {
  const uid = useId();
  const [codeOpen, setCodeOpen] = useState(Boolean(appliedCode));
  const [draft, setDraft] = useState(appliedCode ?? '');
  const removeRef = useRef<HTMLButtonElement>(null);
  const beanies = quote?.beanies;
  const blockedMsg = couponBlocked && couponError && quote ? couponBlockedMessage(couponError, quote.total_inr) : null;
  // A refused code: focus goes to "Remove code", the one thing that unblocks Pay.
  useEffect(() => {
    if (blockedMsg) removeRef.current?.focus();
  }, [blockedMsg]);
  const homeBlend = quote?.lines.some((l) => (l.line ?? 'instant') === 'home_blend') ?? false;

  function apply() {
    const code = draft.trim();
    if (code) onApplyCode(code);
  }

  return (
    <section aria-labelledby="pay-heading">
      <h2 id="pay-heading" className="text-xl font-bold text-charcoal">
        Pay
      </h2>

      {deliverySlot}
      {deliveryRecap ? (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 text-sm text-charcoal">
          <span className="text-muted">Deliver to</span>
          <strong>{deliveryRecap.text}</strong>
          <button
            type="button"
            onClick={deliveryRecap.onChange}
            className="min-h-[44px] px-1 font-semibold text-tan-dark underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
          >
            Change
          </button>
        </p>
      ) : null}

      {priceNote ? (
        <p role="status" className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-sm font-semibold text-charcoal">
          {priceNote}
        </p>
      ) : null}

      <div className="mt-4 rounded-md border border-line bg-cream p-4 shadow-card">
        <h3 className="text-base font-bold text-charcoal">Your order</h3>
        {quote ? (
          <>
            <ul className="mt-2 space-y-1 text-sm">
              {quote.lines.map((l) => (
                <li key={`${l.product_id}:${l.grind ?? ''}`} className="flex justify-between gap-3">
                  <span className="text-charcoal">{lineItemLabel(l)}</span>
                  <span className="font-mono tabular-nums text-charcoal">{rupees(l.line_total_inr)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-2 border-t border-line pt-3 text-sm" aria-live="polite" aria-atomic="false">
              <Row label="Subtotal">{rupees(quote.subtotal_inr)}</Row>
              {quote.offer_discount_inr > 0 ? (
                <Row label={quote.offer_name ?? 'Introductory offer'}>
                  <Saving>{rupees(quote.offer_discount_inr)}</Saving>
                </Row>
              ) : null}
              {quote.coupon_discount_inr > 0 ? (
                <Row label={`Code ${quote.coupon_code ?? ''}`.trim()}>
                  <Saving>{rupees(quote.coupon_discount_inr)}</Saving>
                </Row>
              ) : null}
              {quote.discount_choice_note ? (
                <div>
                  <dt className="sr-only">About your discount</dt>
                  <dd className="text-xs text-muted">{quote.discount_choice_note}</dd>
                </div>
              ) : null}
              {quote.beanies_discount_inr > 0 ? (
                <Row label={`Beanies (${quote.beanies_redeemed})`}>
                  <Saving>{rupees(quote.beanies_discount_inr)}</Saving>
                </Row>
              ) : null}
              <Row label="Shipping">
                {quote.shipping_inr === 0 ? <span className="font-sans font-semibold text-green-800">Free</span> : rupees(quote.shipping_inr)}
              </Row>
              <Row label="Total" strong>
                {rupees(quote.total_inr)}
              </Row>
            </dl>
            {quote.discount_inr > 0 ? (
              <p className="mt-3 text-center text-sm font-semibold text-green-800">You save {rupees(quote.discount_inr)}</p>
            ) : null}
          </>
        ) : cartProblem ? (
          <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
            {cartProblem}
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">Nothing in your order yet.</p>
        )}
        {quoteError ? (
          <p role="status" className="mt-3 text-xs text-muted">
            {quoteError}
          </p>
        ) : loading ? (
          <p role="status" className="mt-3 text-xs text-muted">
            Updating your total…
          </p>
        ) : null}
      </div>

      {quote && quote.nudges.free_shipping ? (
        <p className="mt-3 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">{quote.nudges.free_shipping}</p>
      ) : null}
      {quote && quote.nudges.jar_tier ? <p className="mt-3 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">{quote.nudges.jar_tier}</p> : null}

      {beanies && (beanies.state === 'applied' || beanies.state === 'available_off') ? (
        <div className="mt-4 rounded-md border border-line bg-cream p-4">
          <div
            className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3"
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('[role="switch"]')) onToggleBeanies(!useBeanies);
            }}
          >
            <span id={`${uid}-beanies`} className="text-sm font-semibold text-charcoal">
              Use {beanies.points} Beanies: <span className="font-mono tabular-nums">−{rupees(beanies.discount_inr)}</span> (up to {beanies.max_pct}% on repeat orders)
            </span>
            <ToggleSwitch
              checked={useBeanies}
              onChange={onToggleBeanies}
              label={`Use ${beanies.points} Beanies: minus ${rupees(beanies.discount_inr)} (up to ${beanies.max_pct}% on repeat orders)`}
            />
          </div>
          <p className="mt-1 text-sm text-muted">
            Balance after this order: <span className="font-mono tabular-nums">{beanies.balance_after}</span>
          </p>
        </div>
      ) : null}
      {beanies && beanies.state === 'below_min' ? (
        <p className="mt-4 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
          You have {beanies.balance} Beanies. Use them from {beanies.min_redeem_points}
        </p>
      ) : null}
      {beanies && beanies.state === 'first_order' ? (
        <p className="mt-4 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
          Earn ~{quote?.earn_estimate_points ?? 0} Beanies on this order and save up to {beanies.max_pct}% next time
        </p>
      ) : null}
      {beanies && beanies.state === 'guest' ? (
        <p className="mt-4 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
          <Link href="/login?next=/shop" className="inline-flex min-h-[44px] items-center font-semibold text-tan-dark underline">
            Sign in to earn ~{quote?.earn_estimate_points ?? 0} Beanies on this order and save up to {beanies.max_pct}% next time
          </Link>
        </p>
      ) : null}

      <div className="mt-4">
        {codeOpen || appliedCode ? (
          <div className="rounded-md border border-line bg-cream p-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  label="Discount code"
                  name="coupon"
                  type="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={40}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      apply();
                    }
                  }}
                  error={blockedMsg ?? (appliedCode && couponError ? couponError : undefined)}
                  hint={appliedCode && !couponError && quote?.coupon_code ? `Code ${quote.coupon_code} applied` : undefined}
                />
              </div>
              <Button variant="secondary" className="mt-6" onClick={apply} disabled={!draft.trim() || (loading && draft.trim() === appliedCode)}>
                Apply
              </Button>
            </div>
            {appliedCode ? (
              <Button
                ref={removeRef}
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => {
                  setDraft('');
                  onRemoveCode();
                }}
              >
                Remove code
              </Button>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            aria-expanded="false"
            onClick={() => setCodeOpen(true)}
            className="inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
          >
            Have a code?
          </button>
        )}
      </div>

      <div className="mt-4 space-y-1 text-sm text-muted">
        <p>
          We pack and hand your order to our courier within {DISPATCH_WITHIN}; delivery usually takes {DELIVERY_TAKES} after that, depending on your pincode.
          {homeBlend ? ' Home Blend is ground to order.' : ''}
        </p>
        {signedIn && quote && quote.earn_estimate_points > 0 && beanies?.state !== 'first_order' ? (
          <p className="font-semibold text-charcoal">You&apos;ll earn ~{quote.earn_estimate_points} Beanies when it&apos;s delivered.</p>
        ) : null}
        {paymentReady ? (
          <p>Secure payment by Razorpay · UPI, cards, netbanking · prepaid only</p>
        ) : (
          <p role="status" className="rounded-md bg-surface px-3 py-2 text-charcoal">
            Online payment isn&apos;t available right now. Please check back soon, or buy at the café.
          </p>
        )}
      </div>
    </section>
  );
}
