// Client-side plumbing for the Stock screen (components/staff/inventory/*):
// the JSON shapes the /api/inventory routes return, one fetch wrapper that
// always yields { ok, data, error }, and the shared input styles.

import type { InventoryItemView, PersonRef, StockRequestView } from '@/lib/inventory/server';
import type { StaffSurface } from '@/lib/staff/surfaceRules';

export type { InventoryItemView, PersonRef, StockRequestView };

export interface ItemsPayload {
  items: InventoryItemView[];
  today: string;
  canManage: boolean;
}

export interface RequestsPayload {
  requests: StockRequestView[];
  assignees: PersonRef[];
  actorId: string;
  canManage: boolean;
  surface: StaffSurface;
}

export interface RecipesPayload {
  menu: { id: string; name: string; category: string; variants: { id: string; label: string }[] }[];
  items: { id: string; name: string; unit: string; isActive: boolean }[];
  lines: { menuItemId: string; variantId: string | null; itemId: string; qty: number }[];
  canEdit: boolean;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function api<T>(url: string, method = 'GET', body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { error?: string }).error ?? 'Something went wrong.' };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: 'Network problem — please try again.' };
  }
}

/** No width, for inputs that set their own (w-24, flex-1); inputClass is full width. */
export const inputBase =
  'min-h-[44px] rounded-md border border-[#e5e5e5] bg-white px-3 py-2.5 text-sm focus:border-tan focus:outline-none disabled:bg-[#f6efe9]';
export const inputClass = `${inputBase} w-full`;
export const primaryButton =
  'min-h-[44px] rounded-md bg-tan px-4 py-2.5 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:opacity-50';
export const secondaryButton =
  'min-h-[44px] rounded-md border border-[#ddd] bg-white px-4 py-2.5 text-sm font-bold text-charcoal transition-colors hover:border-charcoal disabled:opacity-50';

/** "2026-10-05" → "5 Oct". */
export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
