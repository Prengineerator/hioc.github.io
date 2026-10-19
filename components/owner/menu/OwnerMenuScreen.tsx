'use client';

// /owner/menu — two tabs held in `?tab=` (so a reload or a link lands on the
// same one): Items, the owner's own menu editor (changes apply at once), and
// Approvals, the add/edit/delete requests staff and managers made on the POS.
// With no `?tab=` the page opens on Approvals when requests are waiting, else Items.
// The pending list lives here because three things read it: the Approvals tab
// label, the "waiting" flags on the item table, and the badge on the owner
// header's Menu tab (published through menuEvents).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Spinner } from '@/components/ui/Spinner';
import { MenuApprovals } from './MenuApprovals';
import { OwnerMenuItems } from './OwnerMenuItems';
import { publishMenuPendingCount } from './menuEvents';
import { OWNER_MENU_TABS, menuTabFromParam, pendingByItemId, type OwnerMenuTab } from './menuDiff';
import { useMenuRequests } from './useMenuRequests';

export function OwnerMenuScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tabParam = params.get('tab');

  const pending = useMenuRequests('pending');
  const pendingCount = pending.requests.length;
  const flags = useMemo(() => pendingByItemId(pending.requests), [pending.requests]);

  // With no `?tab=`, the first pending load picks the tab (a failed load counts
  // as none waiting). It is picked once: a count that changes later, say after
  // the last approval, never moves the owner.
  const [defaultTab, setDefaultTab] = useState<OwnerMenuTab | null>(null);
  useEffect(() => {
    if (defaultTab === null && !pending.loading) setDefaultTab(pendingCount > 0 ? 'approvals' : 'items');
  }, [defaultTab, pending.loading, pendingCount]);
  const tab = tabParam !== null ? menuTabFromParam(tabParam) : defaultTab;

  // Keep the header badge in step with whatever this screen last loaded.
  const settled = !pending.loading && !pending.error;
  useEffect(() => {
    if (settled) publishMenuPendingCount(pendingCount);
  }, [settled, pendingCount]);

  const goTo = useCallback(
    (next: OwnerMenuTab) => {
      // Always explicit, so choosing Items sticks when the default is Approvals.
      router.replace(`${pathname}?tab=${next}`, { scroll: false });
    },
    [router, pathname],
  );

  const reloadPending = pending.reload;
  const handleChanged = useCallback(() => {
    void reloadPending();
  }, [reloadPending]);

  // Hold the tab choice until the first load, rather than flash Items then jump.
  if (tab === null) return <Spinner label="Loading menu…" />;

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Menu sections" className="-mx-4 overflow-x-auto px-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ul className="flex gap-1 border-b border-line">
          {OWNER_MENU_TABS.map((t) => {
            const active = t.id === tab;
            return (
              <li key={t.id} className="shrink-0">
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => goTo(t.id)}
                  className={
                    'flex min-h-[44px] items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-tan ' +
                    (active ? 'border-tan-dark text-charcoal' : 'border-transparent text-muted hover:text-charcoal')
                  }
                >
                  {t.label}
                  {t.id === 'approvals' && pendingCount > 0 ? (
                    <span className="rounded-full bg-tan-dark px-2 py-0.5 text-xs font-bold text-cream">
                      {pendingCount}
                      <span className="sr-only"> waiting</span>
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {tab === 'approvals' ? (
        <MenuApprovals pending={pending} onChanged={handleChanged} />
      ) : (
        <OwnerMenuItems
          pendingByItemId={flags}
          pendingCount={pendingCount}
          onOpenApprovals={() => goTo('approvals')}
          onChanged={handleChanged}
        />
      )}
    </div>
  );
}
