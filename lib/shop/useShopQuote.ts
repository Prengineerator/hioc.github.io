'use client';

// The price the /shop page shows (docs/SHOP-V2-SPEC.md E8). Two figures, one
// answer:
//   - instantly, the local quoteShopCart (the same pure function the server
//     runs) with the introductory offer as the server said at page load, no
//     coupon and no Beanies. It is what the customer sees the moment they tap +.
//   - about 350 ms after the last change, the server's quote from
//     POST /api/shop/quote (offer, coupon, Beanies, shipping, nudges). The
//     server figure WINS: once it has arrived for the current inputs it replaces
//     the local one.
//
// A change in the cart, the code, the Beanies choice or the typed phone / email
// aborts the request in flight and starts the countdown again. A server figure
// for older inputs is never shown as if it were current: until the new one
// arrives the local figure is. A network or server error keeps the local
// figure and says so quietly ("Couldn't refresh the total"); a 400 carries the
// server's own words (a cart it won't price).
//
// `adopt` lets the page drop in the quote a 409 from checkout carried, for the
// inputs as they stand, so "Prices changed: here's the new total" shows the
// server's number at once.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { quoteShopCart, type CartItem, type ShopQuoteV2 } from './pricing';
import type { ShopProduct, ShopSettings } from './types';

export const QUOTE_DEBOUNCE_MS = 350;
export const QUOTE_REFRESH_FAILED = "Couldn't refresh the total";

export interface UseShopQuoteInput {
  products: readonly ShopProduct[];
  settings: ShopSettings;
  /** Whether the viewer may still have the introductory offer, as decided when the page loaded. */
  introEligible: boolean;
  items: readonly CartItem[];
  /** The typed or applied discount code (null for none). */
  couponCode: string | null;
  useBeanies: boolean;
  /** What the customer has entered so far; sent only when it looks complete. */
  phone?: string;
  email?: string;
}

export interface UseShopQuoteResult {
  /** The figure to show: the server's when it has arrived for the current inputs, else the local one. Null for an empty cart or one the local quote refuses. */
  quote: ShopQuoteV2 | null;
  /** True when `quote` came from the server. */
  fromServer: boolean;
  /** The last server quote, even if it is for older inputs (null before the first answer). The Pay step keeps showing it while `loading` (see pickDisplayQuote in checkoutFlow.ts). */
  lastServerQuote: ShopQuoteV2 | null;
  /** Why the typed code was not applied, from the server. */
  couponError: string | null;
  /** A request is in flight or about to start. */
  loading: boolean;
  /** A quiet note when the server figure could not be fetched (the local figure is still shown). */
  error: string | null;
  /** Whether the server says the caller is signed in (null until the first answer). */
  signedIn: boolean | null;
  /** Why the local quote refused the cart (for instance an out-of-stock item), or null. */
  cartProblem: string | null;
  /** Use a quote the checkout route returned (409) for the current inputs. */
  adopt: (quote: ShopQuoteV2, couponError?: string | null) => void;
}

interface ServerAnswer {
  key: string;
  quote: ShopQuoteV2;
  couponError: string | null;
}

const looksLikePhone = (v: string | undefined) => (v ?? '').replace(/\D/g, '').length >= 10;
const looksLikeEmail = (v: string | undefined) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v ?? '').trim());

export function useShopQuote(input: UseShopQuoteInput): UseShopQuoteResult {
  const { products, settings, introEligible, items, couponCode, useBeanies } = input;
  const phone = looksLikePhone(input.phone) ? (input.phone as string).replace(/\D/g, '').slice(-10) : undefined;
  const email = looksLikeEmail(input.email) ? (input.email as string).trim() : undefined;

  // One string stands for "the inputs": when it changes, anything fetched before is stale.
  const key = useMemo(
    () =>
      JSON.stringify({
        items: items.map((i) => [i.product_id, i.grind ?? null, i.quantity]),
        coupon: couponCode ? couponCode.trim().toLowerCase() : null,
        beanies: useBeanies,
        phone: phone ?? null,
        email: email ?? null,
      }),
    [items, couponCode, useBeanies, phone, email],
  );
  const keyRef = useRef(key);
  keyRef.current = key;

  const local = useMemo(() => {
    if (items.length === 0) return { quote: null as ShopQuoteV2 | null, problem: null as string | null };
    const r = quoteShopCart({ products, items, settings, intro_eligible: introEligible, coupon: null, beanies: null });
    if (!r.ok) return { quote: null, problem: r.error };
    const { ok: _ok, ...quote } = r;
    void _ok;
    return { quote: quote as ShopQuoteV2, problem: null };
  }, [products, items, settings, introEligible]);

  const [answer, setAnswer] = useState<ServerAnswer | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  // The latest values for the request, read when the timer fires.
  const bodyRef = useRef({ items, couponCode, useBeanies, phone, email });
  bodyRef.current = { items, couponCode, useBeanies, phone, email };

  useEffect(() => {
    if (items.length === 0) {
      setPending(false);
      setError(null);
      return;
    }
    setPending(true);
    const controller = new AbortController();
    const requestKey = key;
    const timer = setTimeout(async () => {
      const b = bodyRef.current;
      try {
        const res = await fetch('/api/shop/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: b.items.map((i) => (i.grind ? { product_id: i.product_id, quantity: i.quantity, grind: i.grind } : { product_id: i.product_id, quantity: i.quantity })),
            coupon_code: b.couponCode?.trim() || undefined,
            use_beanies: b.useBeanies,
            phone: b.phone,
            email: b.email,
          }),
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => ({}))) as {
          quote?: ShopQuoteV2;
          coupon_error?: string | null;
          signed_in?: boolean;
          error?: string;
        };
        if (controller.signal.aborted || keyRef.current !== requestKey) return;
        if (res.ok && data.quote) {
          setAnswer({ key: requestKey, quote: data.quote, couponError: data.coupon_error ?? null });
          setSignedIn(Boolean(data.signed_in));
          setError(null);
        } else {
          setError(res.status === 400 && data.error ? data.error : QUOTE_REFRESH_FAILED);
        }
      } catch {
        if (controller.signal.aborted) return;
        setError(QUOTE_REFRESH_FAILED);
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `key` covers every input the request carries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const adopt = useCallback((quote: ShopQuoteV2, couponError: string | null = null) => {
    setAnswer({ key: keyRef.current, quote, couponError });
    setError(null);
  }, []);

  const current = answer && answer.key === key && items.length > 0 ? answer : null;
  return {
    quote: current ? current.quote : local.quote,
    fromServer: Boolean(current),
    lastServerQuote: answer && items.length > 0 ? answer.quote : null,
    couponError: current ? current.couponError : null,
    loading: items.length > 0 && pending,
    error: items.length > 0 ? error : null,
    signedIn,
    cartProblem: local.problem,
    adopt,
  };
}
