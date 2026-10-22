'use client';

// POS → Menu → Add-ons: every add-on group ("Choice of Milk") with its choice
// rule, its options and their prices, and how many menu items use it. Staff can
// start a new group or edit one; like menu item changes, the owner's save
// applies at once and anyone else's goes to the owner for approval
// (2026-10-addon-change-requests.sql) — the page shows the "sent" notice and
// the waiting list. Switching an option off for now stays in On / off.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { choiceRuleLabel } from '@/lib/menu/customization';
import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import type { AddonGroup, MenuItem } from '@/lib/types';
import { AddonGroupFormModal, type AddonGroupFormValues } from './AddonGroupFormModal';

const CARD = 'rounded-md border border-line bg-white p-4';

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}

export function AddonGroupsPanel({
  items,
  canEdit,
  approvalNeeded,
  pending,
  onSaved,
}: {
  items: MenuItem[];
  /** Changes are made on the POS only (canEditMenu). */
  canEdit: boolean;
  /** The viewer's saves go to the owner (not the owner themself). */
  approvalNeeded: boolean;
  /** Requests waiting for the owner; add-on ones flag their group. */
  pending: MenuChangeRequest[];
  /** A save went through: `sentForApproval` when it became a request (202). */
  onSaved: (sentForApproval: boolean) => void;
}) {
  const [groups, setGroups] = useState<AddonGroup[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; group: AddonGroup } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/addon-groups', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { addonGroups?: AddonGroup[] };
      setGroups(data.addonGroups ?? []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // An add-on request that leaves the waiting list was decided: reload so an
  // approved change shows here.
  const addonPending = useMemo(() => pending.filter((r) => r.target === 'addon_group'), [pending]);
  const pendingKey = addonPending.map((r) => r.id).sort().join(',');
  const lastKey = useRef(pendingKey);
  useEffect(() => {
    const before = new Set(lastKey.current ? lastKey.current.split(',') : []);
    const now = new Set(pendingKey ? pendingKey.split(',') : []);
    lastKey.current = pendingKey;
    if ([...before].some((id) => !now.has(id))) void load();
  }, [pendingKey, load]);

  const waitingGroupIds = useMemo(
    () => new Set(addonPending.map((r) => r.addon_group_id).filter((id): id is string => Boolean(id))),
    [addonPending],
  );

  const usedBy = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) for (const g of item.addon_groups) counts.set(g.id, (counts.get(g.id) ?? 0) + 1);
    return counts;
  }, [items]);

  async function handleSubmit(values: AddonGroupFormValues) {
    const editing = modal?.mode === 'edit' ? modal.group : null;
    const res = await fetch(editing ? `/api/addon-groups/${editing.id}` : '/api/addon-groups', {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to save the add-on group'));
    setModal(null);
    const sent = res.status === 202;
    if (!sent) void load();
    onSaved(sent);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Add-on groups customers choose from on an item, like milk or extra shots. Attach a group to an item in the
          item&apos;s edit form.
        </p>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setModal({ mode: 'create' })}
            className="rounded-md bg-tan-dark px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-darker"
          >
            New add-on group
          </button>
        ) : null}
      </div>

      {loadError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load the add-ons.{' '}
          <button type="button" onClick={() => void load()} className="font-bold underline">
            Try again
          </button>
        </p>
      ) : groups === null ? (
        <Spinner label="Loading add-ons…" />
      ) : groups.length === 0 ? (
        <p className="rounded-md border border-line bg-cream py-10 text-center text-sm text-muted">No add-on groups yet.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {groups.map((group) => {
            const uses = usedBy.get(group.id) ?? 0;
            return (
              <li key={group.id} className={CARD}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words font-bold text-charcoal">{group.display_name}</h3>
                    <p className="text-xs text-muted">
                      {choiceRuleLabel(group)} · used by {uses} item{uses === 1 ? '' : 's'}
                    </p>
                    {waitingGroupIds.has(group.id) ? (
                      <span className="mt-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900">
                        Edit waiting for owner
                      </span>
                    ) : null}
                  </div>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => setModal({ mode: 'edit', group })}
                      aria-label={`Edit ${group.display_name}`}
                      className="shrink-0 rounded-md border border-line px-3 py-1.5 text-sm font-bold text-charcoal hover:border-tan"
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
                <ul className="mt-3 flex flex-col divide-y divide-line text-sm">
                  {group.options.map((option) => (
                    <li key={option.id} className="flex items-center justify-between gap-3 py-1.5">
                      <span className={'min-w-0 break-words ' + (option.is_available === false ? 'text-muted' : 'text-charcoal')}>
                        {option.name}
                        {option.is_available === false ? (
                          <span className="ml-2 rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted">
                            Off
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-tan-dark">
                        {option.price_inr > 0 ? `+₹${option.price_inr}` : 'Free'}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      {modal ? (
        <AddonGroupFormModal
          mode={modal.mode}
          initial={modal.mode === 'edit' ? modal.group : undefined}
          approvalNeeded={approvalNeeded}
          onClose={() => setModal(null)}
          onSubmit={handleSubmit}
        />
      ) : null}
    </div>
  );
}
