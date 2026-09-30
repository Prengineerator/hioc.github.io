'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SurfaceLink } from '@/components/SurfaceLink';
import { Button, buttonVariants } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { EligibleDrinks } from '@/components/passes/EligibleDrinks';
import { PassCard } from '@/components/passes/PassCard';
import { PlanCard } from '@/components/passes/PlanCard';
import { useRitualOffer } from '@/components/passes/useRitualOffer';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import type { CoffeePassPlan, PassSummary } from '@/lib/passes/types';
import {
  findPassForOrder,
  passReadyMessage,
  paymentDismissedMessage,
  planBuyLabel,
  purchaseError,
  usablePasses,
  type PurchaseErrorAction,
  type RitualMine,
} from '@/lib/passes/ui';
import { openRazorpayCheckout } from '@/lib/payments/razorpayCheckout';
import type { CreatedPaymentIntent } from '@/lib/payments/types';

// After the payment window reports success the pass is issued by the database
// the moment the order is paid (CP-D6), which is normally within a second or
// two. Ask for it every 2 seconds, for about 30, before saying "still setting
// up". Every other ask also nudges the gateway reconciliation the order page
// uses, in case the webhook is late.
const CONFIRM_INTERVAL_MS = 2000;
const CONFIRM_MAX_ASKS = 15;

type BuyState =
  | { phase: 'idle' }
  | { phase: 'starting'; planId: string }
  | { phase: 'paying'; planId: string }
  | { phase: 'confirming'; orderId: string; planName: string }
  | { phase: 'done'; pass: PassSummary }
  | { phase: 'delayed'; orderId: string; planName: string }
  | { phase: 'error'; message: string; action: PurchaseErrorAction };

type MineState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: RitualMine };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const notePanel = 'rounded-md border border-tan bg-surface px-4 py-3 text-sm text-charcoal';

/**
 * The interactive part of /ritual: the plans and their Buy buttons, the
 * purchase (checkout, Razorpay, waiting for the pass to appear), and "Your
 * Ritual" for a signed-in customer. The hero, "How it works" and the terms are
 * static and render on the server around it (app/ritual/page.tsx).
 */
export function RitualExperience({ signedIn: signedInAtLoad }: { signedIn: boolean }) {
  const offerState = useRitualOffer({ fresh: true });
  const [signedIn, setSignedIn] = useState(signedInAtLoad);
  const [mine, setMine] = useState<MineState>({ status: 'loading' });
  const [buy, setBuy] = useState<BuyState>({ phase: 'idle' });

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The customer's own passes. `quiet` (the wait-for-the-pass loop) leaves a
  // list that is already showing alone if one read fails.
  const fetchMine = useCallback(async (quiet: boolean): Promise<RitualMine | null> => {
    try {
      const res = await fetch('/api/passes/mine', { cache: 'no-store' });
      if (res.status === 401) {
        if (mounted.current) setSignedIn(false);
        return null;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as Partial<RitualMine>;
      const next: RitualMine = {
        passes: Array.isArray(data.passes) ? data.passes.map((p) => ({ ...p, history: p.history ?? [] })) : [],
        phone_verified: data.phone_verified === true,
        pending: Array.isArray(data.pending) ? data.pending : [],
      };
      if (mounted.current) setMine({ status: 'ready', data: next });
      return next;
    } catch {
      if (!quiet && mounted.current) setMine({ status: 'error' });
      return null;
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void fetchMine(false);
    // Only the first load: a purchase re-reads it itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Best-effort: the payment window opens with the customer's name and number
  // filled in, as the checkout's does. Nothing depends on it.
  const prefill = useRef<{ name: string; phone: string }>({ name: '', phone: '' });
  useEffect(() => {
    if (!signedInAtLoad) return;
    let cancelled = false;
    fetch('/api/account/me', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== 'object') return;
        const profile = ('profile' in data ? (data as { profile?: unknown }).profile : data) as
          | { name?: unknown; phone?: unknown }
          | undefined;
        prefill.current = {
          name: typeof profile?.name === 'string' ? profile.name.trim() : '',
          phone: typeof profile?.phone === 'string' ? profile.phone.trim() : '',
        };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signedInAtLoad]);

  // The purchase status sits at the top of the page but the Buy button that
  // caused it is further down, so bring it into view (the checkout does the same
  // for its error banner).
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (buy.phase === 'idle' || buy.phase === 'starting' || buy.phase === 'paying') return;
    statusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [buy.phase]);

  // Wait for the sale order's pass to be issued.
  const confirmPurchase = useCallback(
    async (orderId: string, planName: string) => {
      setBuy({ phase: 'confirming', orderId, planName });
      for (let ask = 0; ask < CONFIRM_MAX_ASKS; ask++) {
        if (ask > 0) {
          await sleep(CONFIRM_INTERVAL_MS);
          if (!mounted.current) return;
          if (ask % 2 === 0) {
            try {
              await fetch(`/api/payments/${orderId}/status`, { cache: 'no-store' });
            } catch {
              // Best-effort: the webhook, or the next ask, will catch it up.
            }
          }
        }
        const latest = await fetchMine(true);
        if (!mounted.current) return;
        const pass = latest ? findPassForOrder(latest.passes, orderId) : null;
        if (pass) {
          setBuy({ phase: 'done', pass });
          return;
        }
      }
      if (mounted.current) setBuy({ phase: 'delayed', orderId, planName });
    },
    [fetchMine],
  );

  const startPurchase = useCallback(
    async (plan: CoffeePassPlan) => {
      setBuy({ phase: 'starting', planId: plan.id });
      try {
        const res = await fetch('/api/passes/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan_id: plan.id }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          order_id?: string;
          payment?: CreatedPaymentIntent;
        };
        if (!res.ok || !data.order_id || !data.payment) {
          if (res.status === 401) setSignedIn(false);
          setBuy({ phase: 'error', ...purchaseError(res.status, data.error) });
          return;
        }
        const orderId = data.order_id;
        setBuy({ phase: 'paying', planId: plan.id });
        // Every outcome is handled here rather than on another page: a success
        // waits for the pass, a closed window says so and leaves Buy available.
        await openRazorpayCheckout(data.payment, {
          name: prefill.current.name,
          phone: prefill.current.phone,
          description: `${PASS_PROGRAM_NAME} — ${plan.name}`,
          onSuccess: () => {
            void confirmPurchase(orderId, plan.name);
          },
          onDismiss: (lastFailure) => {
            setBuy({ phase: 'error', message: paymentDismissedMessage(lastFailure), action: 'retry' });
            // The purchase is listed as "processing" until the gateway says otherwise.
            void fetchMine(true);
          },
          onFailure: (message) => {
            setBuy({
              phase: 'error',
              message: `${message} If any money was taken, your ${PASS_PROGRAM_NAME} will appear below once the payment is confirmed.`,
              action: 'retry',
            });
            void fetchMine(true);
          },
        });
      } catch {
        setBuy({ phase: 'error', message: 'Network error — please check your connection.', action: 'retry' });
      }
    },
    [confirmPurchase, fetchMine],
  );

  const offer = offerState.offer;
  const busy = buy.phase === 'starting' || buy.phase === 'paying' || buy.phase === 'confirming';

  function buyControl(plan: CoffeePassPlan) {
    if (offer && !offer.online_purchase) {
      return (
        <p className="rounded-md bg-surface px-4 py-3 text-sm font-semibold text-charcoal">
          Buy at the counter — just give us your number.
        </p>
      );
    }
    if (!signedIn) {
      return (
        <SurfaceLink href="/login?next=/ritual" className={buttonVariants({ fullWidth: true })}>
          Log in to buy
        </SurfaceLink>
      );
    }
    const thisPlan = (buy.phase === 'starting' || buy.phase === 'paying') && buy.planId === plan.id;
    return (
      <Button fullWidth loading={thisPlan} disabled={busy} onClick={() => void startPurchase(plan)}>
        {thisPlan ? (buy.phase === 'starting' ? 'Starting…' : 'Opening payment…') : planBuyLabel(plan)}
      </Button>
    );
  }

  return (
    <div>
      <div ref={statusRef} aria-live="polite" className="empty:hidden">
        <PurchaseStatus
          buy={buy}
          onCheckAgain={(orderId, planName) => void confirmPurchase(orderId, planName)}
        />
      </div>

      {signedIn ? (
        <YourRitual mine={mine} onRetry={() => { setMine({ status: 'loading' }); void fetchMine(false); }} />
      ) : null}

      <section aria-labelledby="ritual-plans" className="mt-8">
        <h2 id="ritual-plans" className="text-xl font-bold text-charcoal">
          Pick a plan
        </h2>
        {offerState.status === 'loading' ? (
          <div aria-hidden="true" className="mt-4 grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-72 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        ) : offerState.status === 'error' ? (
          <div className="mt-4">
            <EmptyState
              icon="⚠️"
              heading="Couldn't load the plans"
              body="Check your connection and try again."
              action={
                <Button variant="secondary" onClick={offerState.reload}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : offer && offer.plans.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              heading="No plans on sale right now"
              body={`${PASS_PROGRAM_NAME} is between plans. Check back soon, or ask us at the counter.`}
              action={
                <SurfaceLink href="/menu" className={buttonVariants({ variant: 'secondary' })}>
                  See the menu
                </SurfaceLink>
              }
            />
          </div>
        ) : offer ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {offer.plans.map((plan) => (
              <PlanCard key={plan.id} plan={plan} gst={offer.gst} action={buyControl(plan)} />
            ))}
          </div>
        ) : null}
      </section>

      {offer ? <EligibleDrinks eligible={offer.eligible} /> : null}
    </div>
  );
}

// What the purchase is doing, in a panel above everything else. Empty (and so
// hidden, by `empty:hidden` on its wrapper) while nothing is happening.
function PurchaseStatus({
  buy,
  onCheckAgain,
}: {
  buy: BuyState;
  onCheckAgain: (orderId: string, planName: string) => void;
}) {
  switch (buy.phase) {
    case 'confirming':
      return (
        <div role="status" className={notePanel + ' mt-6 flex items-center gap-3'}>
          <span
            aria-hidden="true"
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-tan-dark border-t-transparent"
          />
          <span>
            <span className="font-semibold">Confirming your payment…</span> your {buy.planName} will be ready in a
            few seconds.
          </span>
        </div>
      );
    case 'done':
      return (
        <div role="status" className="mt-6 rounded-md border border-green-700/30 bg-green-50 p-4 text-charcoal">
          <p className="font-bold">{passReadyMessage(buy.pass)}</p>
          <p className="mt-1 text-sm">Order as usual — your cups are applied for you at checkout.</p>
          <SurfaceLink href="/menu" className={buttonVariants({ className: 'mt-3' })}>
            Order now
          </SurfaceLink>
        </div>
      );
    case 'delayed':
      return (
        <div role="status" className={notePanel + ' mt-6'}>
          <p className="font-semibold">Still setting up your {buy.planName}</p>
          <p className="mt-1">
            If your payment went through, it will show under Your {PASS_PROGRAM_NAME} in a moment. Try
            &ldquo;Check again&rdquo; in a minute, or ask us at the counter.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => onCheckAgain(buy.orderId, buy.planName)}>
            Check again
          </Button>
        </div>
      );
    case 'error':
      return (
        <div role="alert" className={notePanel + ' mt-6'}>
          <p>{buy.message}</p>
          {buy.action === 'login' ? (
            <SurfaceLink
              href="/login?next=/ritual"
              className="mt-2 inline-flex min-h-[44px] items-center font-semibold text-tan-dark underline"
            >
              Log in
            </SurfaceLink>
          ) : null}
          {buy.action === 'profile' ? (
            <SurfaceLink
              href="/account/profile"
              className="mt-2 inline-flex min-h-[44px] items-center font-semibold text-tan-dark underline"
            >
              Add my number in Profile
            </SurfaceLink>
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

// "Your Ritual" for a signed-in customer: their passes, a note while a payment
// is still landing, and a nudge to verify the number the counter will look them
// up by.
function YourRitual({ mine, onRetry }: { mine: MineState; onRetry: () => void }) {
  return (
    <section aria-labelledby="your-ritual" className="mt-8">
      <h2 id="your-ritual" className="text-xl font-bold text-charcoal">
        Your {PASS_PROGRAM_NAME}
      </h2>

      {mine.status === 'loading' ? (
        <div aria-hidden="true" className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-36 w-full" />
        </div>
      ) : mine.status === 'error' ? (
        <div className="mt-4 rounded-md border border-line bg-cream p-4">
          <p className="text-sm text-charcoal">Couldn&apos;t load your {PASS_PROGRAM_NAME}.</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {mine.data.pending.length > 0 ? (
            <p role="status" className={notePanel + ' mt-4'}>
              <span className="font-semibold">Payment processing…</span> If you&apos;ve just paid, your{' '}
              {PASS_PROGRAM_NAME} will show up here in a moment.
            </p>
          ) : null}

          {mine.data.passes.length === 0 ? (
            mine.data.pending.length === 0 ? (
              <p className="mt-3 text-sm text-muted">
                You don&apos;t have a {PASS_PROGRAM_NAME} yet — pick a plan below.
              </p>
            ) : null
          ) : (
            <>
              {!mine.data.phone_verified && usablePasses(mine.data.passes).length > 0 ? (
                <SurfaceLink
                  href="/account/profile"
                  className="mt-4 flex min-h-[44px] items-center justify-between gap-3 rounded-md border border-tan bg-surface px-4 py-2 text-sm font-semibold text-charcoal hover:border-tan-dark"
                >
                  <span>Verify your number in Profile to use your {PASS_PROGRAM_NAME} at the counter</span>
                  <span aria-hidden="true">→</span>
                </SurfaceLink>
              ) : null}
              <ul className="mt-4 flex flex-col gap-3">
                {mine.data.passes.map((pass) => (
                  <li key={pass.id}>
                    <PassCard pass={pass} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
