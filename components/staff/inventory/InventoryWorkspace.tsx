'use client';

// The Stock screen (/staff/inventory, docs/INVENTORY-SPEC.md): three tabs —
// Stock (levels, expiry, "Request stock"), Requests (assign → pick → verify
// at the POS) and Recipes. Loads stock and requests together because the
// Stock tab shows which items are already requested; recipes load on first
// open. Refreshes when the tab regains focus, so a phone left on the screen
// catches up with a pick made elsewhere.

import { useCallback, useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { canAssign, canPick, canReceive, type RequestActor } from '@/lib/inventory/rules';
import { api, type ItemsPayload, type RecipesPayload, type RequestsPayload } from '@/components/staff/inventory/client';
import { StockTab } from '@/components/staff/inventory/StockTab';
import { RequestsTab } from '@/components/staff/inventory/RequestsTab';
import { RecipesTab } from '@/components/staff/inventory/RecipesTab';

type Tab = 'stock' | 'requests' | 'recipes';
const TABS: { id: Tab; label: string }[] = [
  { id: 'stock', label: 'Stock' },
  { id: 'requests', label: 'Requests' },
  { id: 'recipes', label: 'Recipes' },
];

export function InventoryWorkspace() {
  const [tab, setTab] = useState<Tab>('stock');
  const [items, setItems] = useState<ItemsPayload | null>(null);
  const [requests, setRequests] = useState<RequestsPayload | null>(null);
  const [recipes, setRecipes] = useState<RecipesPayload | null>(null);
  const [error, setError] = useState('');

  const loadStock = useCallback(async () => {
    const [i, r] = await Promise.all([
      api<ItemsPayload>('/api/inventory/items'),
      api<RequestsPayload>('/api/inventory/requests'),
    ]);
    if (i.ok) setItems(i.data);
    if (r.ok) setRequests(r.data);
    setError(!i.ok ? i.error : !r.ok ? r.error : '');
  }, []);

  const loadRecipes = useCallback(async () => {
    const res = await api<RecipesPayload>('/api/inventory/recipes');
    if (res.ok) setRecipes(res.data);
    else setError(res.error);
  }, []);

  useEffect(() => {
    void loadStock();
    const onFocus = () => void loadStock();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadStock]);

  useEffect(() => {
    if (tab === 'recipes' && !recipes) void loadRecipes();
  }, [tab, recipes, loadRecipes]);

  // Requests waiting on THIS person: to assign, to pick, or to verify here.
  const waitingOnMe = requests
    ? requests.requests.filter((r) => {
        const actor: RequestActor = {
          userId: requests.actorId,
          role: requests.canManage ? 'manager' : 'staff',
          surface: requests.surface,
        };
        const f = {
          status: r.status,
          requested_by: r.requestedBy.id,
          assigned_to: r.assignedTo?.id ?? null,
          picked_by: r.pickedBy?.id ?? null,
        };
        return (
          (r.status === 'requested' && canAssign(f, actor).ok) ||
          (r.assignedTo?.id === requests.actorId && canPick(f, actor).ok) ||
          canReceive(f, actor).ok
        );
      }).length
    : 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-bold text-charcoal">Stock</h1>
      <div className="mt-4 flex gap-1 border-b border-[#e5e5e5]" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`min-h-[44px] border-b-2 px-4 text-sm font-bold ${
              tab === t.id ? 'border-tan text-charcoal' : 'border-transparent text-muted hover:text-charcoal'
            }`}
          >
            {t.label}
            {t.id === 'requests' && waitingOnMe > 0 ? (
              <span className="ml-2 rounded-full bg-tan px-2 py-0.5 text-xs text-cream">{waitingOnMe}</span>
            ) : null}
          </button>
        ))}
      </div>

      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}

      <div className="mt-5">
        {tab === 'stock' ? (
          items && requests ? (
            <StockTab data={items} surface={requests.surface} reload={loadStock} onRequested={() => setTab('requests')} />
          ) : (
            <Spinner />
          )
        ) : null}
        {tab === 'requests' ? (
          requests && items ? <RequestsTab data={requests} today={items.today} reload={loadStock} /> : <Spinner />
        ) : null}
        {tab === 'recipes' ? recipes ? <RecipesTab data={recipes} reload={loadRecipes} /> : <Spinner /> : null}
      </div>
    </div>
  );
}
