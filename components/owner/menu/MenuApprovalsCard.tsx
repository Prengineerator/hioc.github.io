// The Approvals card on the /owner overview: menu changes staff and managers
// made on the POS that are waiting for the owner's OK — the pending count, the
// three newest requests, and a link into /owner/menu?tab=approvals.
//
// A plain server-rendered card: the overview page loads the requests (see
// loadMenuApprovals there) and passes them in. It shows no error state of its
// own — if the requests couldn't be loaded the page leaves the card out, the
// same as the Marketing and Payments cards.

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card } from '@/components/owner/dashboard';
import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import { timeAgo } from '@/lib/utils/timeAgo';
import { formatIstDateTime, requestActionLabel } from './menuDiff';

/** How many of the newest pending requests the card lists. */
export const MENU_APPROVALS_PREVIEW = 3;

export function MenuApprovalsCard({
  pendingCount,
  requests,
}: {
  /** Every pending request, not just the ones listed. */
  pendingCount: number;
  /** The newest pending requests, newest first. */
  requests: MenuChangeRequest[];
}) {
  const shown = requests.slice(0, MENU_APPROVALS_PREVIEW);
  const more = pendingCount - shown.length;

  if (pendingCount === 0) {
    return (
      <Card title="Approvals">
        <div className="flex flex-wrap items-center justify-between gap-x-4">
          <p className="text-sm text-muted">No menu changes waiting</p>
          <Link href="/owner/menu" className="inline-flex min-h-[44px] items-center text-sm text-muted hover:text-charcoal hover:underline">
            Open menu →
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Approvals">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <div className="flex items-baseline gap-2">
          <p className="font-mono text-2xl font-bold tabular-nums text-charcoal">{pendingCount}</p>
          <p className="text-sm text-muted">{pendingCount === 1 ? 'menu change waiting' : 'menu changes waiting'}</p>
        </div>
        <Link href="/owner/menu?tab=approvals" className="inline-flex min-h-[44px] items-center text-sm font-bold text-tan-dark hover:underline">
          Review →
        </Link>
      </div>
      <ul className="mt-2 flex flex-col">
        {shown.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[#f2efe9] py-2 text-sm">
            <span className="inline-block shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900">
              {requestActionLabel(r)}
            </span>
            <span className="min-w-0 flex-1 truncate font-bold text-charcoal">{r.item_name || (r.target === 'addon_group' ? 'Untitled add-on group' : 'Untitled item')}</span>
            <span className="shrink-0 text-xs text-muted">
              {r.requested_by_name || 'Unknown'} ·{' '}
              <time dateTime={r.requested_at} title={`${formatIstDateTime(r.requested_at)} IST`}>
                {timeAgo(r.requested_at)}
              </time>
            </span>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="mt-1 text-xs text-muted">and {more} more</p> : null}
    </Card>
  );
}
