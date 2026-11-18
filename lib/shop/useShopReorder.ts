'use client';

// "Order again" for a shop order (docs/SHOP-V2-SPEC.md E4): asks
// GET /api/account/shop-reorder/[orderId] for the order re-priced against
// today's catalogue, drops the result into the shop cart storage
// (lib/shop/cart.ts) on its Pay step, and opens /shop?step=pay. The /shop page
// reads `?step=pay` plus the stored cart. The café cart is never touched.

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { writeShopCart } from '@/lib/shop/cart';
import type { ShopReorderResponse } from '@/lib/shop/reorder';

export interface ShopReorderResult {
  ok: boolean;
  /** Plain-words summary of what was skipped or re-priced ('' if nothing). */
  notice: string;
  error?: string;
}

/** "Nutty Hazelnut is out of stock right now · Home Blend 500 g is now ₹649 (was ₹599)" */
export function reorderNotice(data: Pick<ShopReorderResponse, 'skipped' | 'modified'>): string {
  const parts: string[] = [];
  for (const s of data.skipped ?? []) {
    if (s.reason === 'Choose a grind again') parts.push(`Choose a grind again for ${s.name}`);
    else if (s.reason.startsWith('Order limit')) parts.push(`${s.reason} (${s.name} was trimmed)`);
    else parts.push(`${s.name} is ${s.reason.charAt(0).toLowerCase()}${s.reason.slice(1)}`);
  }
  for (const m of data.modified ?? []) {
    parts.push(`${m.name} is now ₹${m.new_price_inr} (was ₹${m.old_price_inr})`);
  }
  return parts.join(' · ');
}

export function useShopReorder() {
  const router = useRouter();
  const [reorderingId, setReorderingId] = useState<string | null>(null);

  const reorder = useCallback(
    async (orderId: string): Promise<ShopReorderResult> => {
      setReorderingId(orderId);
      try {
        const res = await fetch(`/api/account/shop-reorder/${orderId}`, { cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as Partial<ShopReorderResponse> & { error?: string };
        if (!res.ok) {
          return { ok: false, notice: '', error: data.error ?? 'Could not reorder this order.' };
        }
        const notice = reorderNotice({ skipped: data.skipped ?? [], modified: data.modified ?? [] });
        if (!data.items || data.items.length === 0) {
          return { ok: false, notice, error: notice || 'None of these items are available right now.' };
        }
        writeShopCart({
          items: data.items,
          address_id: data.address_id ?? null,
          address: data.address ?? null,
          notice: notice || null,
          step: 'pay',
        });
        router.push('/shop?step=pay');
        return { ok: true, notice };
      } catch {
        return { ok: false, notice: '', error: 'Network error. Please try again.' };
      } finally {
        setReorderingId(null);
      }
    },
    [router],
  );

  return { reorder, reorderingId };
}
