'use client';

// All · Café · Shop segmented chips (docs/SHOP-V2-SPEC.md E4). Real buttons with
// aria-pressed, 44 px tall. The choice lives in the URL (?channel=) so a reload
// or a shared link keeps it; router.replace with scroll:false means no jump and
// no extra history entry. Renders nothing while the shop is off: there is only
// the café, so there is nothing to filter.

import { usePathname, useRouter } from 'next/navigation';
import { flags } from '@/lib/flags';
import type { HistoryChannelFilter } from '@/lib/account/historyTypes';

const CHOICES: { value: HistoryChannelFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'cafe', label: 'Café' },
  { value: 'shop', label: 'Shop' },
];

/** Reads ?channel= safely: anything unknown (or the shop being off) is 'all'. */
export function parseChannel(raw: string | null | undefined): HistoryChannelFilter {
  if (!flags.shop) return 'all';
  return raw === 'cafe' || raw === 'shop' ? raw : 'all';
}

export function ChannelFilter({
  value,
  onChange,
}: {
  value: HistoryChannelFilter;
  onChange?: (next: HistoryChannelFilter) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  if (!flags.shop) return null;

  function pick(next: HistoryChannelFilter) {
    if (next === value) return;
    const params = new URLSearchParams(window.location.search);
    if (next === 'all') params.delete('channel');
    else params.set('channel', next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    onChange?.(next);
  }

  return (
    <div role="group" aria-label="Show orders from" className="flex gap-1 rounded-md border border-muted/80 p-1 text-sm">
      {CHOICES.map((c) => (
        <button
          key={c.value}
          type="button"
          aria-pressed={value === c.value}
          onClick={() => pick(c.value)}
          className={
            'flex min-h-[44px] flex-1 items-center justify-center rounded px-3 font-semibold transition-colors ' +
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
            (value === c.value ? 'bg-tan-dark text-cream' : 'text-charcoal hover:bg-surface')
          }
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
