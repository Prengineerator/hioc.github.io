'use client';

// "Order again" (ACC-4), shared by the account orders page and the menu's
// Order-again strip: resolves a past order against the CURRENT menu via
// GET /api/account/reorder/[orderId] and adds every still-available line to
// the cart. Callers decide what happens next (go to checkout, open the cart).

import { useCallback, useState } from 'react';
import { useCart } from '@/lib/cart/CartContext';

export interface ReorderResult {
  ok: boolean;
  /** How many lines were added to the cart. */
  added: number;
  /** Human-readable notes about skipped items / dropped add-ons ('' if none). */
  notice: string;
  /** Set when nothing could be added (request failed). */
  error?: string;
}

export function useReorder() {
  const { addItem } = useCart();
  const [reorderingId, setReorderingId] = useState<string | null>(null);

  const reorder = useCallback(
    async (orderId: string): Promise<ReorderResult> => {
      setReorderingId(orderId);
      try {
        const res = await fetch(`/api/account/reorder/${orderId}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { ok: false, added: 0, notice: '', error: data.error ?? 'Could not reorder this order.' };
        }
        const lines = data.items ?? [];
        for (const line of lines) {
          const { qty, ...rest } = line;
          addItem(rest, qty);
        }
        const notes: string[] = [];
        if (data.skipped?.length) {
          notes.push(
            `Skipped (unavailable): ${data.skipped.map((s: { name: string }) => s.name).join(', ')}`,
          );
        }
        if (data.modified?.length) {
          notes.push(
            `Some add-ons dropped for: ${data.modified.map((m: { name: string }) => m.name).join(', ')}`,
          );
        }
        return { ok: true, added: lines.length, notice: notes.join(' · ') };
      } catch {
        return { ok: false, added: 0, notice: '', error: 'Network error — please try again.' };
      } finally {
        setReorderingId(null);
      }
    },
    [addItem],
  );

  return { reorder, reorderingId };
}
