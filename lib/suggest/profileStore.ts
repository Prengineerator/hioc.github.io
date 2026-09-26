// Phase 7 · SUG-5 — the taste-profile read-through cache
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.5). The maths (buildTasteProfile,
// summarizeProfile, pickUsual) lives in lib/suggest/profile.ts (pure); this
// file owns the Supabase reads, the staleness decision and the upsert.
//
// 'server-only' — service-role reads (customer_taste_profiles has no public
// policy beyond "read your own row"; this always needs the admin client to
// WRITE it).

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { buildTasteProfile, type TasteProfileOrder } from './profile';
import { SUGGEST_LIMITS } from './types';
import type { CustomerTasteProfileRow, Daypart, MenuItemTraits, TasteProfile } from './types';
import type { OrderStatus } from '@/lib/types';
import {
  filterOrdersInWindow,
  legacyOrdersForProfile,
  mergeProfileOrders,
  newestLegacyOrderAt,
  type ProfileRawOrder,
} from './legacyOrders';

export interface ProfileResult {
  profile: TasteProfile | null;
  optedOut: boolean;
}

function windowStartIso(now: Date): string {
  return new Date(now.getTime() - SUGGEST_LIMITS.profileWindowDays * 24 * 60 * 60 * 1000).toISOString();
}

/** §5.5 "Freshness": recompute when computed_at is older than the TTL, OR the
 * customer has an order newer than source_order_at. */
function isStale(row: CustomerTasteProfileRow, newestOrderAt: string | null, now: Date): boolean {
  const ttlMs = SUGGEST_LIMITS.profileTtlHours * 60 * 60 * 1000;
  if (now.getTime() - new Date(row.computed_at).getTime() > ttlMs) return true;
  if (newestOrderAt) {
    if (!row.source_order_at) return true;
    if (new Date(newestOrderAt).getTime() > new Date(row.source_order_at).getTime()) return true;
  }
  return false;
}

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;

/** Every order belonging to this customer, EITHER by the web session
 * (`user_id`) OR by a verified-phone counter link (`customer_user_id` — F4),
 * newest first, at most `limit` rows. Degrades to `user_id` alone if that
 * column isn't deployed yet, same tolerance app/api/account/history/route.ts
 * applies to it. */
async function selectOrdersForCustomer(admin: AdminClient, userId: string, select: string, limit: number) {
  const linked = await admin
    .from('orders')
    .select(select)
    .or(`user_id.eq.${userId},customer_user_id.eq.${userId}`)
    .not('status', 'in', '("rejected","cancelled")')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (linked.error && isMissingColumnError(linked.error)) {
    return admin
      .from('orders')
      .select(select)
      .eq('user_id', userId)
      .not('status', 'in', '("rejected","cancelled")')
      .order('created_at', { ascending: false })
      .limit(limit);
  }
  return linked;
}

/**
 * Plain-language summary for the /account "Your taste profile" card (§5.5).
 * Warm, deterministic, and NEVER mentions money, spend or order counts.
 */
export function plainLanguageSummary(profile: TasteProfile | null): string {
  if (!profile || profile.topItems.length === 0) {
    return "We don't have enough orders yet to notice a pattern — that's alright.";
  }

  const daypartPhrase: Record<Daypart, string> = {
    morning: 'in the morning',
    afternoon: 'in the afternoon',
    evening: 'in the evening',
    late: 'late in the day',
  };
  const [topDaypart, topShare] = (Object.entries(profile.daypartHistogram) as [Daypart, number][]).sort(
    (a, b) => b[1] - a[1],
  )[0] ?? ['afternoon', 0];

  const tempPhrase =
    profile.traitLean.icedShare >= 0.65 ? 'iced drinks' : profile.traitLean.icedShare <= 0.35 ? 'hot drinks' : 'a mix of hot and iced drinks';

  const topCategory = Object.entries(profile.categoryAffinity).sort((a, b) => b[1] - a[1])[0]?.[0];

  const parts = [`You usually go for ${tempPhrase}`];
  if (topShare > 0) parts.push(daypartPhrase[topDaypart]);
  if (topCategory) parts.push(`— often from ${topCategory}`);
  return `${parts.join(' ')}.`;
}

/**
 * Read-through cache (§5.5). Returns `{ profile: null, optedOut: true }`
 * without reading orders at all when the customer opted out. Otherwise
 * returns the cached profile if it's fresh, or rebuilds + upserts it when
 * stale/missing. Never throws — a read/write failure degrades to whatever
 * can still be answered (cached profile, or null), logged.
 */
export async function getOrBuildProfile(userId: string, now: Date = new Date()): Promise<ProfileResult> {
  const admin = createAdminSupabaseClient();

  const { data: existing, error: readError } = await admin
    .from('customer_taste_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (readError) {
    console.error('getOrBuildProfile: read failed', readError);
    return { profile: null, optedOut: false };
  }
  const row = existing as CustomerTasteProfileRow | null;

  if (row?.opted_out) {
    return { profile: null, optedOut: true };
  }

  // Look up the customer's verified phone (profiles.phone is free text; only
  // phone_verified = true can safely link to Petpooja bills — an unverified
  // phone is just "someone claims this number", which says nothing about
  // whether it's really them; see lib/loyalty/customerLink.ts).
  let verifiedPhone: string | null = null;
  const { data: profileData, error: profileError } = await admin
    .from('profiles')
    .select('phone, phone_verified')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) {
    console.error('getOrBuildProfile: profiles lookup failed', profileError);
  } else if (profileData) {
    const p = profileData as { phone: string | null; phone_verified: boolean | null };
    if (p.phone_verified && p.phone) {
      verifiedPhone = p.phone;
    }
  }

  // Cheap staleness probe — just the newest qualifying order's timestamp,
  // not the full order+line join the rebuild below needs. Include both app
  // orders and Petpooja bills (if phone is verified) to capture all of a
  // customer's activity.
  const latest = await selectOrdersForCustomer(admin, userId, 'created_at', 1);
  if (latest.error) {
    console.error('getOrBuildProfile: latest-order probe failed', latest.error);
    return { profile: (row?.profile as TasteProfile | undefined) ?? null, optedOut: false };
  }
  let newestOrderAt = ((latest.data ?? [])[0] as unknown as { created_at: string } | undefined)?.created_at ?? null;

  // Also check the newest Petpooja bill (if verified phone links this customer)
  // and use whichever is more recent.
  if (verifiedPhone) {
    const newestLegacy = await newestLegacyOrderAt(admin, verifiedPhone);
    if (newestLegacy && (!newestOrderAt || new Date(newestLegacy).getTime() > new Date(newestOrderAt).getTime())) {
      newestOrderAt = newestLegacy;
    }
  }

  if (row && !isStale(row, newestOrderAt, now)) {
    return { profile: row.profile as TasteProfile, optedOut: false };
  }

  // Rebuild: full orders (+ lines) and favorites, bounded to the window/count
  // buildTasteProfile itself also enforces (belt and braces — keeps the query
  // bounded even before the pure function gets a look). Fetch app orders and
  // Petpooja bills (if verified phone) in parallel, then window and merge both.
  const [ordersResult, favoritesResult, legacyOrdersResult] = await Promise.all([
    selectOrdersForCustomer(
      admin,
      userId,
      'status, created_at, total_inr, subtotal_inr, order_items(menu_item_id, quantity, voided)',
      SUGGEST_LIMITS.profileMaxOrders,
    ),
    admin.from('favorites').select('menu_item_id').eq('user_id', userId),
    verifiedPhone ? legacyOrdersForProfile(admin, verifiedPhone, SUGGEST_LIMITS.profileMaxOrders) : Promise.resolve([]),
  ]);

  if (ordersResult.error) {
    console.error('getOrBuildProfile: orders load failed', ordersResult.error);
    return { profile: (row?.profile as TasteProfile | undefined) ?? null, optedOut: false };
  }
  if (favoritesResult.error) {
    console.error('getOrBuildProfile: favorites load failed', favoritesResult.error);
  }

  const windowStart = new Date(windowStartIso(now)).getTime();
  // Map app orders to ProfileRawOrder shape (status is cast to OrderStatus since
  // app orders always have valid status by the time they reach here, matching
  // the DB constraint that legacy_orders.status is 'completed' | 'cancelled').
  const appRawOrders: ProfileRawOrder[] = ((ordersResult.data ?? []) as unknown as Array<{
    status: string;
    created_at: string;
    total_inr: number | null;
    subtotal_inr: number;
    order_items: { menu_item_id: string | null; quantity: number; voided: boolean }[] | null;
  }>).map((o) => ({
    status: o.status as OrderStatus,
    created_at: o.created_at,
    total_inr: o.total_inr,
    subtotal_inr: o.subtotal_inr,
    order_items: o.order_items,
  }));

  // Window and merge: apply the time filter to both sources separately (to avoid
  // dropping a newer in-window order from one side to a cap limit), then cap the merged list.
  const windowedAppOrders = filterOrdersInWindow(appRawOrders, windowStart);
  const windowedLegacyOrders = filterOrdersInWindow(legacyOrdersResult, windowStart);
  const rawOrders = mergeProfileOrders(windowedAppOrders, windowedLegacyOrders, SUGGEST_LIMITS.profileMaxOrders);
  const favorites = (favoritesResult.data ?? []).map((f) => f.menu_item_id as string);

  const itemIds = [
    ...new Set(
      rawOrders.flatMap((o) => (o.order_items ?? []).map((l) => l.menu_item_id)).filter((id): id is string => Boolean(id)),
    ),
  ];

  let categoryById = new Map<string, string>();
  let traitsById = new Map<string, MenuItemTraits>();
  if (itemIds.length > 0) {
    const [itemsResult, traitsResult] = await Promise.all([
      admin.from('menu_items').select('id, category').in('id', itemIds),
      admin.from('menu_item_traits').select('*').in('menu_item_id', itemIds),
    ]);
    if (itemsResult.error) console.error('getOrBuildProfile: menu item categories failed', itemsResult.error);
    else categoryById = new Map((itemsResult.data ?? []).map((r) => [r.id as string, r.category as string]));
    if (traitsResult.error) console.error('getOrBuildProfile: traits failed', traitsResult.error);
    else traitsById = new Map((traitsResult.data ?? []).map((r) => [r.menu_item_id as string, r as unknown as MenuItemTraits]));
  }

  const orders: TasteProfileOrder[] = rawOrders.map((o) => ({
    status: o.status as TasteProfileOrder['status'],
    created_at: o.created_at,
    total_inr: o.total_inr,
    subtotal_inr: o.subtotal_inr,
    items: (o.order_items ?? []).map((l) => ({
      menu_item_id: l.menu_item_id,
      category: l.menu_item_id ? (categoryById.get(l.menu_item_id) ?? '') : '',
      quantity: l.quantity,
      voided: l.voided,
    })),
  })) as TasteProfileOrder[];

  const profile = buildTasteProfile({ orders, favorites, traitsById, now });

  const { error: upsertError } = await admin.from('customer_taste_profiles').upsert(
    {
      user_id: userId,
      profile,
      order_count: orders.length,
      computed_at: now.toISOString(),
      source_order_at: newestOrderAt ?? orders[0]?.created_at ?? null,
      opted_out: false,
    },
    { onConflict: 'user_id' },
  );
  if (upsertError) {
    console.error('getOrBuildProfile: upsert failed (returning computed profile anyway)', upsertError);
  }

  return { profile, optedOut: false };
}

/**
 * §5.5: `POST /api/orders` marks the profile stale (rather than recomputing
 * inline) whenever an order changes what a customer's history looks like.
 * Best-effort: never throws, and a missing row is a harmless no-op update.
 */
export async function markProfileStale(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  try {
    const admin = createAdminSupabaseClient();
    const { error } = await admin
      .from('customer_taste_profiles')
      .update({ computed_at: new Date(0).toISOString() })
      .eq('user_id', userId);
    if (error) console.error('markProfileStale failed (best-effort)', error);
  } catch (err) {
    console.error('markProfileStale threw (best-effort)', err);
  }
}
