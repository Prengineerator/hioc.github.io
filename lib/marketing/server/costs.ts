// Product costs (COGS) — the one number the agent cannot infer, and the reason a "free
// coffee" offer can be priced honestly (spec §1.6, §3). One row per VARIANT, because
// prices live on menu_item_variants: a Cold Coffee's Regular and Large cost different amounts.
//
// Costs are owner-only. They live in menu_item_costs (RLS on, no policy) and reach the
// browser ONLY through the owner-gated /api/owner/marketing/costs — never a column on the
// publicly readable menu tables, never a field of /api/menu.

import 'server-only';
import { blendedFoodCost, rankFreeItems } from '@/lib/marketing/economics';
import { ECONOMICS_WINDOW_DAYS, DEFAULT_SETTINGS } from '@/lib/marketing/types';
import type { CostInput, CostRow, CostsResponse } from '@/lib/marketing/types';
import { DAY_MS } from '@/lib/marketing/ist';
import {
  IN_CHUNK,
  assertOk,
  chunk,
  loadCostMap,
  loadFoodCostLines,
  loadMenuVariants,
  loadSettings,
  marketingAdmin,
  toFreeItemInputs,
  type Admin,
} from './repo';

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * GET /costs: one row per variant (with its item's name, category and availability), the
 * share of the last 90 days' revenue that rests on a REAL entered cost, and the free-item
 * ranking (variants ranked by perceived value per rupee of cost). PUT returns the same.
 */
export async function listCosts(now: Date = new Date(), admin: Admin = marketingAdmin()): Promise<CostsResponse> {
  const since90 = new Date(now.getTime() - ECONOMICS_WINDOW_DAYS * DAY_MS).toISOString();
  const settings = await loadSettings(admin);
  const defaultPct = (settings ?? DEFAULT_SETTINGS).default_food_cost_pct;

  const [menu, costs, lines] = await Promise.all([loadMenuVariants(admin), loadCostMap(admin), loadFoodCostLines(admin, since90)]);

  const revenueByVariant = new Map<string, number>();
  for (const line of lines) {
    if (line.voided || !line.variant_id) continue;
    revenueByVariant.set(line.variant_id, (revenueByVariant.get(line.variant_id) ?? 0) + line.line_total_inr);
  }

  const items: CostRow[] = menu.map((v) => {
    const cost = costs.has(v.variant_id) ? (costs.get(v.variant_id) as number) : null;
    return {
      variant_id: v.variant_id,
      item_id: v.item_id,
      category: v.category,
      item_name: v.item_name,
      variant_label: v.variant_label,
      price_inr: v.price_inr,
      cost_inr: cost,
      food_cost_pct: cost !== null && v.price_inr > 0 ? round((100 * cost) / v.price_inr, 1) : null,
      margin_inr: cost !== null ? round(v.price_inr - cost, 2) : null,
      is_available: v.is_available,
      revenue_90d_inr: Math.round(revenueByVariant.get(v.variant_id) ?? 0),
    };
  });

  return {
    items,
    default_food_cost_pct: defaultPct,
    coverage_pct: round(blendedFoodCost(lines, costs, defaultPct).coverage_pct, 1),
    free_item_ranking: rankFreeItems(toFreeItemInputs(menu, costs)),
  };
}

export type PutCostsResult = { ok: true; response: CostsResponse } | { ok: false; error: string };

/**
 * PUT /costs: `cost_inr` upserts, null deletes. The server looks up each variant's
 * menu_item_id itself — a client never says which item a variant belongs to — and an id
 * that is not a real variant rejects the WHOLE request, so a typo cannot half-apply.
 */
export async function putCosts(costs: readonly CostInput[], userId: string | null, now: Date = new Date()): Promise<PutCostsResult> {
  const admin = marketingAdmin();
  const ids = costs.map((c) => c.variant_id);

  const itemOf = new Map<string, string>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await admin.from('menu_item_variants').select('id, menu_item_id').in('id', part);
    assertOk('menu_item_variants read', error);
    for (const v of (data ?? []) as { id: string; menu_item_id: string }[]) itemOf.set(v.id, v.menu_item_id);
  }
  const unknown = ids.filter((id) => !itemOf.has(id));
  if (unknown.length > 0) {
    return { ok: false, error: `${unknown.length === 1 ? 'That item size does' : `${unknown.length} item sizes do`} not exist on the menu (${unknown.slice(0, 3).join(', ')}).` };
  }

  const nowIso = now.toISOString();
  const upserts = costs
    .filter((c) => c.cost_inr !== null)
    .map((c) => ({
      variant_id: c.variant_id,
      menu_item_id: itemOf.get(c.variant_id) as string,
      cost_inr: c.cost_inr as number,
      updated_at: nowIso,
      updated_by: userId,
    }));
  const deletes = costs.filter((c) => c.cost_inr === null).map((c) => c.variant_id);

  for (const part of chunk(upserts, 200)) {
    const { error } = await admin.from('menu_item_costs').upsert(part, { onConflict: 'variant_id' });
    assertOk('menu_item_costs write', error);
  }
  for (const part of chunk(deletes, IN_CHUNK)) {
    const { error } = await admin.from('menu_item_costs').delete().in('variant_id', part);
    assertOk('menu_item_costs delete', error);
  }

  return { ok: true, response: await listCosts(now, admin) };
}
