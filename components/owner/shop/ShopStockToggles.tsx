'use client';

// Owner → Shop orders: the three flavours' "in stock" switches. Off = the
// flavour shows "Out of stock" on /shop and can't be ordered.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { rupees } from '@/lib/shop/pricing';
import type { ShopProduct } from '@/lib/shop/types';

export function ShopStockToggles({ products }: { products: ShopProduct[] }) {
  const router = useRouter();
  const [stock, setStock] = useState<Record<string, boolean>>(() => Object.fromEntries(products.map((p) => [p.id, p.in_stock])));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(p: ShopProduct, next: boolean) {
    setBusy(p.id);
    setError(null);
    setStock((s) => ({ ...s, [p.id]: next }));
    try {
      const res = await fetch(`/api/owner/shop/products/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ in_stock: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Could not save');
      }
      router.refresh();
    } catch (err) {
      setStock((s) => ({ ...s, [p.id]: !next }));
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <ul className="divide-y divide-line">
        {products.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
            <div>
              <p className="font-semibold text-charcoal">{p.name}</p>
              <p className="text-xs text-muted">
                {rupees(p.price_inr)} · {p.net_qty} · {stock[p.id] ? 'In stock' : 'Out of stock'}
              </p>
            </div>
            <div className={busy === p.id ? 'opacity-50' : ''}>
              <ToggleSwitch checked={stock[p.id]} onChange={(next) => void toggle(p, next)} label={`${p.name} in stock`} />
            </div>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
