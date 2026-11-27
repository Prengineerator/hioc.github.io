import { DEFAULT_HOME_BLEND_GRAMS, packLabel } from '@/lib/shop/catalog';

// Pure helpers for the two product-line cards at the top of /shop.

/** window CustomEvent: a pack tile on /shop asks the ordering card to select that pack. */
export const SELECT_PACK_EVENT = 'hioc:shop-select-pack';

export interface HomeBlendTile {
  id: string;
  grams: number;
  label: string;
  priceInr: number;
  inStock: boolean;
  /** The everyday pack, flagged with a text label (never colour alone). */
  popular: boolean;
}

/** One tile per listed Home Blend pack, smallest first. */
export function homeBlendTiles(
  packs: readonly { id?: string; pack_grams: number; price_inr: number; in_stock?: boolean }[],
): HomeBlendTile[] {
  return [...packs]
    .sort((a, b) => a.pack_grams - b.pack_grams)
    .map((p) => ({
      id: p.id ?? '',
      grams: p.pack_grams,
      label: packLabel(p.pack_grams),
      priceInr: p.price_inr,
      inStock: p.in_stock !== false,
      popular: p.pack_grams === DEFAULT_HOME_BLEND_GRAMS,
    }));
}

/** Which cards to render: only a line with listed products gets one. */
export function productLinesToShow(instantCount: number, homeBlendCount: number): { instant: boolean; homeBlend: boolean } {
  return { instant: instantCount > 0, homeBlend: homeBlendCount > 0 };
}

/** The pack id to select for a select-pack event, or null: only a listed, in-stock pack is accepted. */
export function acceptedPackId(
  detail: unknown,
  packs: readonly { id: string; listed: boolean; in_stock: boolean }[],
): string | null {
  if (!detail || typeof detail !== 'object') return null;
  const id = (detail as { productId?: unknown }).productId;
  if (typeof id !== 'string') return null;
  return packs.some((p) => p.id === id && p.listed && p.in_stock) ? id : null;
}

/** The cheapest pack for "From ₹225 (100 g sample)": built from the listed packs, never hard-coded. */
export function homeBlendFromLabel(tiles: readonly HomeBlendTile[]): { priceInr: number; note: string } | null {
  const cheapest = [...tiles].sort((a, b) => a.priceInr - b.priceInr)[0];
  if (!cheapest) return null;
  return { priceInr: cheapest.priceInr, note: `(${cheapest.label}${cheapest.grams <= 100 ? ' sample' : ''})` };
}
