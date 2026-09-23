'use client';

// POS-1 keyboard-first quick-add command bar. Autofocused primary input for
// counter staff: type a shortform -> live ranked dropdown -> Enter commits the
// top match (parent decides add-direct vs. open the customize modal, and guards
// 86'd). Qty grammar "3*cap" is parsed for the ×N chip. Ctrl/⌘+Enter jumps
// straight to Charge. Pure resolution lives in lib/pos/quickAdd — this file is
// only UI + keyboard wiring; it never touches money or the cart directly.

import { useEffect, useId, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { parseQuickAddInput, resolveQuickAdd, type QuickAddCandidate } from '@/lib/pos/quickAdd';
import type { MenuItem } from '@/lib/types';

const DROPDOWN_LIMIT = 8;

function priceLabel(item: MenuItem): string {
  const prices = item.variants.map((v) => v.price_inr);
  const min = prices.length ? Math.min(...prices) : 0;
  return item.variants.length > 1 ? `from ₹${min}` : `₹${min}`;
}

export function PosQuickAddBar({
  items,
  query,
  onQueryChange,
  onPick,
  onCharge,
  inputRef,
}: {
  items: MenuItem[];
  query: string;
  onQueryChange: (q: string) => void;
  onPick: (item: MenuItem, qty: number) => void;
  onCharge: () => void;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const listboxId = useId();
  const parsed = useMemo(() => parseQuickAddInput(query), [query]);
  const candidates = useMemo(
    () => resolveQuickAdd(parsed.term, items, { limit: DROPDOWN_LIMIT }),
    [parsed.term, items],
  );

  const [highlight, setHighlight] = useState(0);
  // Reset the highlight to the top match whenever the result set changes.
  useEffect(() => {
    setHighlight(0);
  }, [candidates]);

  const open = parsed.term.length > 0;
  const activeId = open && candidates.length ? `${listboxId}-opt-${highlight}` : undefined;

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        onCharge();
        return;
      }
      if (candidates.length > 0) {
        e.preventDefault();
        const chosen = candidates[Math.min(highlight, candidates.length - 1)];
        onPick(chosen.item, parsed.qty);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      if (!candidates.length) return;
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, candidates.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!candidates.length) return;
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === 'Escape') {
      if (query.length > 0) {
        e.preventDefault();
        onQueryChange('');
      }
    }
  }

  return (
    <div className="relative mb-3">
      <div className="flex items-center gap-2 rounded-md border border-[#e5e5e5] px-3 focus-within:border-tan">
        <span aria-hidden className="text-muted">
          ⌨
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          placeholder="Type to add… (e.g. cap, 3*latte)"
          className="w-full bg-transparent py-2 text-sm text-charcoal outline-none"
        />
        {parsed.qty > 1 ? (
          <span className="shrink-0 rounded-full bg-tan px-2 py-0.5 text-xs font-bold text-cream">
            ×{parsed.qty}
          </span>
        ) : null}
      </div>

      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-[22rem] w-full overflow-y-auto rounded-md border border-[#e5e5e5] bg-cream shadow-lg"
        >
          {candidates.length === 0 ? (
            <li className="px-3 py-3 text-sm text-muted">No item matches “{parsed.term}”.</li>
          ) : (
            candidates.map((c, i) => (
              <QuickAddRow
                key={c.item.id}
                id={`${listboxId}-opt-${i}`}
                candidate={c}
                active={i === highlight}
                onHover={() => setHighlight(i)}
                onPick={() => onPick(c.item, parsed.qty)}
              />
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

function QuickAddRow({
  id,
  candidate,
  active,
  onHover,
  onPick,
}: {
  id: string;
  candidate: QuickAddCandidate;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const { item, available } = candidate;
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={!available}
      onMouseEnter={onHover}
      // mouseDown (not click) so the input never blurs before we commit — keeps
      // the keyboard-first flow intact when staff tap a row.
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={
        'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ' +
        (active ? 'bg-[#f6efe9]' : '') +
        (available ? '' : ' opacity-50')
      }
    >
      <span
        aria-hidden
        className={
          'flex h-3 w-3 shrink-0 items-center justify-center border ' +
          (item.is_veg ? 'border-green-700' : 'border-red-700')
        }
      >
        <span
          className={'h-1 w-1 rounded-full ' + (item.is_veg ? 'bg-green-700' : 'bg-red-700')}
        />
      </span>
      <span className="min-w-0 flex-1 truncate font-bold text-charcoal">{item.name}</span>
      <span className="hidden shrink-0 text-xs text-muted sm:inline">{item.category}</span>
      {item.short_code ? (
        <span className="shrink-0 rounded border border-[#e5e5e5] px-1 font-mono text-[10px] font-bold uppercase text-muted">
          {item.short_code}
        </span>
      ) : null}
      {!available ? (
        <span className="shrink-0 text-[10px] font-bold text-muted">86’d</span>
      ) : (
        <span className="shrink-0 text-xs font-bold text-tan">{priceLabel(item)}</span>
      )}
    </li>
  );
}
