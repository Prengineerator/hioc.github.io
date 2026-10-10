'use client';

// Checkout "Pairs well with your order" card (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md
// §1.2, §4.2, §4.3). Sits directly under the "Your Order" card (CartSummary) and
// offers up to three things that go with what is already in the cart, each with
// an Add button.
//
// The contract with the rest of the checkout is "never get in the way":
//  - it renders NOTHING (no skeleton, no placeholder) until a request has come
//    back with picks, so nothing shifts while it loads, and nothing is left behind
//    if the flag is off, the request fails, or there is nothing to suggest;
//  - the request is fire-and-forget as far as the checkout is concerned: any
//    failure is swallowed, and a slow or out-of-order answer can never overwrite a
//    newer one;
//  - its events are analytics only, sent with keepalive, failures ignored.

import { useEffect, useMemo, useRef, useState } from 'react';
import { CoffeyMascot } from '@/components/coffey/CoffeyMascot';
import { MenuItemCustomizeModal } from '@/components/menu/MenuItemCustomizeModal';
import { MenuItemImage } from '@/components/menu/MenuItemImage';
import { getAnonId } from '@/components/suggest/api';
import { Button } from '@/components/ui/Button';
import { useCart } from '@/lib/cart/CartContext';
import { minVariantPriceInr, quickAddLine } from '@/lib/cart/pairingAdd';
import { flags } from '@/lib/flags';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { PAIRING_LIMITS } from '@/lib/suggest/types';
import type { ClientPairingEventType, PairingPick, PairingResponse } from '@/lib/suggest/types';
import type { MenuItem } from '@/lib/types';

const PAIRINGS_ENDPOINT = '/api/suggest/pairings';
const EVENTS_ENDPOINT = '/api/suggest/pairings/events';
/** A burst of cart changes asks once, for the final cart. */
const FETCH_DEBOUNCE_MS = 400;

interface PairingEventInput {
  event: ClientPairingEventType;
  menuItemId: string;
  anchorItemId: string;
}

/** POST /api/suggest/pairings/events. Fire-and-forget: never throws, never waits. */
function postPairingEvents(events: PairingEventInput[]): void {
  if (events.length === 0) return;
  try {
    fetch(EVENTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anonId: getAnonId(), events: events.slice(0, PAIRING_LIMITS.eventsPerRequest) }),
      keepalive: true,
    }).catch(() => {
      // analytics only
    });
  } catch {
    // Never let an events failure touch the checkout.
  }
}

/** The response, if it is the shape we expect; null otherwise. */
function readResponse(data: unknown): PairingResponse | null {
  if (typeof data !== 'object' || data === null) return null;
  const { picks, items } = data as { picks?: unknown; items?: unknown };
  if (!Array.isArray(picks) || !Array.isArray(items)) return null;
  return {
    picks: picks.filter(
      (p): p is PairingPick =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as PairingPick).menuItemId === 'string' &&
        typeof (p as PairingPick).anchorItemId === 'string' &&
        typeof (p as PairingPick).reason === 'string',
    ),
    items: items.filter(
      (i): i is MenuItem =>
        typeof i === 'object' &&
        i !== null &&
        typeof (i as MenuItem).id === 'string' &&
        Array.isArray((i as MenuItem).variants) &&
        Array.isArray((i as MenuItem).addon_groups),
    ),
  };
}

export interface PairingRow {
  pick: PairingPick;
  item: MenuItem;
  /** The cheapest size, for "from ₹min". */
  minPriceInr: number;
}

/** The pick being customised in the modal, and how big the cart was when it opened. */
interface ModalTarget {
  item: MenuItem;
  anchorItemId: string;
  beforeTotalItems: number;
}

/**
 * The card itself, apart from the fetching and cart logic so its markup can be
 * rendered and checked on its own (tests/pairsWellWithCard.test.ts). One row per
 * pick: thumbnail, name, reason, "from ₹min" and an Add button.
 *
 * Narrow screens (360 px): the text column has `min-w-0` and breaks long words, the
 * thumbnail and the button keep their size, and the card pads 16 px instead of 24 so
 * the text keeps its room. Every tap target is at least 44 px (Button's own minimum).
 */
export function PairsWellWithCard({ rows, onAdd }: { rows: PairingRow[]; onAdd: (row: PairingRow) => void }) {
  return (
    <section
      aria-labelledby="pairs-well-heading"
      className="rounded-md border border-line bg-cream p-4 shadow-sm sm:p-6"
    >
      <div className="mb-3 flex items-center gap-2">
        <CoffeyMascot size={20} animated={false} />
        <h2 id="pairs-well-heading" className="text-lg font-semibold text-charcoal">
          Pairs well with your order
        </h2>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {rows.map((row) => (
          <li key={row.item.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <MenuItemImage item={row.item} className="h-14 w-14 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <span
                  role="img"
                  aria-label={row.item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}
                  title={row.item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}
                  className={
                    'mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center border ' +
                    (row.item.is_veg ? 'border-green-700' : 'border-red-700')
                  }
                >
                  <span className={'h-1.5 w-1.5 rounded-full ' + (row.item.is_veg ? 'bg-green-700' : 'bg-red-700')} />
                </span>
                <p className="min-w-0 break-words font-semibold leading-snug text-charcoal">{row.item.name}</p>
              </div>
              <p className="mt-0.5 break-words text-sm text-muted">{row.pick.reason}</p>
              <p className="mt-0.5 text-sm text-muted">
                from <span className="font-mono font-bold tabular-nums text-tan-dark">₹{row.minPriceInr}</span>
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Add ${row.item.name} to your order`}
              onClick={() => onAdd(row)}
              className="shrink-0"
            >
              Add
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PairsWellWith() {
  const { items, hydrated, totalItems, addItem, setPendingPairingAnchorId } = useCart();

  const [result, setResult] = useState<PairingResponse | null>(null);
  const [modalTarget, setModalTarget] = useState<ModalTarget | null>(null);
  const [closedModalTarget, setClosedModalTarget] = useState<ModalTarget | null>(null);

  // The distinct items in the cart, sorted so the same cart in a different order
  // is the same request. A string, so it is a stable effect dependency.
  const idsKey = useMemo(
    () =>
      [...new Set(items.map((i) => i.menuItemId))]
        .sort()
        .slice(0, PAIRING_LIMITS.cartItemsMax)
        .join(','),
    [items],
  );
  const inCart = useMemo(() => new Set(items.map((i) => i.menuItemId)), [items]);

  // Only the newest request may update the card, the way CheckoutForm's quote
  // does it (quoteSeq): bumped when a request is scheduled and again when it is
  // abandoned, so a slow answer for an older cart finds the number has moved on.
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!flags.checkoutPairings || !hydrated) return;
    const seq = ++requestSeq.current;
    if (!idsKey) {
      setResult(null);
      return () => {
        requestSeq.current += 1;
      };
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(PAIRINGS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemIds: idsKey.split(',') }),
        });
        if (!res.ok) return; // keep what is showing (or nothing)
        const parsed = readResponse(await res.json());
        if (!parsed || seq !== requestSeq.current) return;
        setResult(parsed);
      } catch {
        // The checkout never waits on, or fails because of, this card.
      }
    }, FETCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      requestSeq.current += 1;
    };
  }, [idsKey, hydrated]);

  // What to show: the picks whose items are still orderable and not already in
  // the cart. Filtering on the CURRENT cart is what makes a row vanish the moment
  // it is added, without waiting for the refetch.
  const rows = useMemo<PairingRow[]>(() => {
    if (!result) return [];
    const byId = new Map(result.items.map((i) => [i.id, i]));
    const out: PairingRow[] = [];
    for (const pick of result.picks) {
      if (inCart.has(pick.menuItemId)) continue;
      const item = byId.get(pick.menuItemId);
      if (!item || !isMenuItemAvailable(item)) continue;
      const minPriceInr = minVariantPriceInr(item);
      if (minPriceInr === null) continue;
      out.push({ pick, item, minPriceInr });
    }
    return out.slice(0, PAIRING_LIMITS.picks);
  }, [result, inCart]);

  // 'shown': once per item per page view, the rows of one response in one request.
  const shownRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = rows.filter((r) => !shownRef.current.has(r.item.id));
    if (fresh.length === 0) return;
    for (const r of fresh) shownRef.current.add(r.item.id);
    postPairingEvents(
      fresh.map((r) => ({ event: 'shown', menuItemId: r.item.id, anchorItemId: r.pick.anchorItemId })),
    );
  }, [rows]);

  // 'added' for a modal add: the modal calls addItem() itself, so the only sign it
  // happened is that the cart grew by the time it closed (SuggestWizard does the
  // same). A Cancel / Escape / X close leaves the cart alone and fires nothing.
  useEffect(() => {
    if (!closedModalTarget) return;
    if (totalItems > closedModalTarget.beforeTotalItems) {
      postPairingEvents([
        {
          event: 'added',
          menuItemId: closedModalTarget.item.id,
          anchorItemId: closedModalTarget.anchorItemId,
        },
      ]);
    }
    setClosedModalTarget(null);
  }, [totalItems, closedModalTarget]);

  function handleAdd(row: PairingRow) {
    const line = quickAddLine(row.item, row.pick.anchorItemId);
    if (line) {
      addItem(line);
      postPairingEvents([{ event: 'added', menuItemId: row.item.id, anchorItemId: row.pick.anchorItemId }]);
      return;
    }
    // Needs a choice (sizes, a required add-on that costs money, …): the existing
    // customise modal does the adding. It calls addItem() itself, so the anchor
    // rides along on the cart's one-shot pending hint.
    setPendingPairingAnchorId(row.pick.anchorItemId);
    setModalTarget({ item: row.item, anchorItemId: row.pick.anchorItemId, beforeTotalItems: totalItems });
  }

  function handleCloseModal() {
    setClosedModalTarget(modalTarget);
    setModalTarget(null);
    // Closed without adding: don't let the hint leak onto some later line.
    setPendingPairingAnchorId(null);
  }

  if (!flags.checkoutPairings) return null;

  return (
    <>
      {rows.length > 0 ? <PairsWellWithCard rows={rows} onAdd={handleAdd} /> : null}
      {modalTarget ? <MenuItemCustomizeModal item={modalTarget.item} onClose={handleCloseModal} /> : null}
    </>
  );
}
