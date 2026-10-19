'use client';

// Approvals sub-tab of /owner/menu: the menu changes staff and managers made on
// the POS, held until the owner approves or rejects them. Filter tabs mirror
// the feedback inbox (Pending / Approved / Rejected / All). The Pending list is
// owned by the screen (it also feeds the tab badge and the "pending" flags on
// the item table); the other filters load their own list.

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Notice, TabIntro } from '@/components/owner/marketing/ui';
import type { AddonGroup } from '@/lib/types';
import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import { MenuRequestCard } from './MenuRequestCard';
import { REQUEST_FILTERS, type RequestFilter } from './menuDiff';
import { useMenuRequests, type MenuRequestsState } from './useMenuRequests';

const EMPTY_TEXT: Record<RequestFilter, { heading: string; body: string }> = {
  pending: {
    heading: 'Nothing is waiting for approval',
    body: 'When staff or managers add, edit or delete a menu item on the POS, the request shows up here first.',
  },
  approved: { heading: 'No approved requests yet', body: 'Requests you approve are listed here.' },
  rejected: { heading: 'No rejected requests', body: 'Requests you reject are listed here, with your note.' },
  all: { heading: 'No requests yet', body: 'Nothing has been requested from the POS so far.' },
};

export function MenuApprovals({
  pending,
  onChanged,
}: {
  /** The screen's Pending list (shared with the tab badge and the item table). */
  pending: MenuRequestsState;
  /** A request was decided: the menu and the pending list may have changed. */
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<RequestFilter>('pending');
  const [flash, setFlash] = useState<string | null>(null);
  const [addonNames, setAddonNames] = useState<Record<string, string>>({});

  // Pending reuses the screen's list; the other filters fetch their own.
  const own = useMenuRequests(filter, { skip: filter === 'pending' });
  const list = filter === 'pending' ? pending : own;

  // Add-on group names for the diffs. Best effort: without them a group reads "Unknown group".
  useEffect(() => {
    let alive = true;
    fetch('/api/addon-groups')
      .then((res) => res.json())
      .then((data: { addonGroups?: AddonGroup[] }) => {
        if (!alive) return;
        const names: Record<string, string> = {};
        for (const g of data.addonGroups ?? []) names[g.id] = g.display_name || g.name;
        setAddonNames(names);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 8000);
    return () => clearTimeout(t);
  }, [flash]);

  function handleDecided(updated: MenuChangeRequest, message: string) {
    list.apply(updated);
    setFlash(message);
    onChanged();
    if (filter !== 'pending') void own.reload();
  }

  // The API refused because the request moved on (already decided, item gone):
  // refresh so the list shows where things really are.
  function handleConflict() {
    void list.reload();
    if (filter !== 'pending') onChanged();
  }

  const pendingCount = pending.requests.length;
  const empty = EMPTY_TEXT[filter];

  return (
    <div className="flex flex-col gap-5">
      <TabIntro title="Menu changes from the POS">
        Staff and managers can&apos;t change the menu on their own. Anything they add, edit or delete waits here until you approve it. Sold-out
        switches and add-on toggles still apply straight away.
      </TabIntro>

      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter requests">
        {REQUEST_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={
              'min-h-[44px] rounded-md px-3 text-sm font-bold sm:min-h-[36px] ' +
              (filter === f.id ? 'bg-charcoal text-cream' : 'bg-surface text-charcoal hover:bg-[#f2efe9]')
            }
          >
            {f.label}
            {f.id === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </div>

      {flash ? (
        <Notice tone="good" role="status">
          {flash}
        </Notice>
      ) : null}

      {list.loading ? (
        <Spinner label="Loading menu requests…" />
      ) : list.error ? (
        <Notice
          tone="bad"
          role="alert"
          title="This did not load"
          action={
            <Button variant="secondary" size="sm" onClick={() => void list.retry()}>
              Try again
            </Button>
          }
        >
          {list.error}
        </Notice>
      ) : list.requests.length === 0 ? (
        <div className="rounded-md border border-line bg-cream p-8 text-center shadow-sm">
          <p className="font-bold text-charcoal">{empty.heading}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">{empty.body}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {list.requests.map((r) => (
            <MenuRequestCard key={r.id} request={r} addonNames={addonNames} onDecided={handleDecided} onConflict={handleConflict} />
          ))}
        </div>
      )}
    </div>
  );
}
