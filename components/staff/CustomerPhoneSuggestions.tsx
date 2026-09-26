'use client';

// Customer suggestions under a POS phone field: type 4+ digits and the
// matching customers (GET /api/customers/search) drop down — name, number,
// last visit. Picking one fills the number; the exact lookup then does the
// rest (name, points, Last orders).

import { useEffect, useState } from 'react';
import { phoneSearchPrefix, type CustomerSuggestion } from '@/lib/customers/phoneSearch';

const DEBOUNCE_MS = 250;

/** Matches for what's in the phone field; [] when there's nothing to suggest. */
export function useCustomerSuggestions(raw: string, enabled = true): CustomerSuggestion[] {
  const [matches, setMatches] = useState<CustomerSuggestion[]>([]);
  const prefix = enabled ? phoneSearchPrefix(raw) : null;

  useEffect(() => {
    if (!prefix) {
      setMatches([]);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/customers/search?q=${encodeURIComponent(prefix.slice(3))}`, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { customers?: CustomerSuggestion[] } | null) => {
          if (!cancelled) setMatches(data?.customers ?? []);
        })
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [prefix]);

  return prefix ? matches : [];
}

function lastVisit(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function CustomerSuggestionList({
  matches,
  highlighted = -1,
  onPick,
  id,
}: {
  matches: CustomerSuggestion[];
  highlighted?: number;
  onPick: (c: CustomerSuggestion) => void;
  id?: string;
}) {
  if (matches.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Matching customers"
      className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-[#e5e5e5] bg-white py-1 shadow-lg"
    >
      {matches.map((c, i) => (
        <li key={c.phone} role="option" aria-selected={i === highlighted}>
          <button
            type="button"
            // mousedown, not click: the phone field's blur would otherwise
            // close the list before the tap lands.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            className={
              'flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ' +
              (i === highlighted ? 'bg-[#f2efe9]' : 'hover:bg-[#f7f4ef]')
            }
          >
            <span className="min-w-0">
              <span className="block truncate font-bold text-charcoal">{c.name || 'No name'}</span>
              <span className="block font-mono text-xs tabular-nums text-muted">{c.phone}</span>
            </span>
            <span className="shrink-0 text-right text-[11px] text-muted">
              {c.order_count > 0 ? `${c.order_count} order${c.order_count === 1 ? '' : 's'}` : ''}
              {c.last_order_at ? <span className="block">{lastVisit(c.last_order_at)}</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
