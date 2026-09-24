import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { MENU_ITEM_SELECT, shapeMenuItem, type MenuItemRow } from '@/lib/orders/lines';
import { isOverBudget } from '@/lib/suggest/budget';
import { runSuggest } from '@/lib/suggest/engine';
import { activeDecider } from '@/lib/suggest/llm';
import { dailyBudgetUsdMicros, llmDisabledReason, llmEnabled } from '@/lib/suggest/models';
import { getOrBuildProfile } from '@/lib/suggest/profileStore';
import { templateHeader } from '@/lib/suggest/templates';
import { todaySpendMicros } from '@/lib/suggest/spend';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';
import { validateSuggestRequest } from '@/lib/suggest/validate';
import type { Decider, FallbackReason, MenuItemTraits, SuggestResponse } from '@/lib/suggest/types';
import type { MenuItem } from '@/lib/types';

export const dynamic = 'force-dynamic';
// SUGGEST_LIMITS.deciderTimeoutMs is 9s; with menu/traits/popularity loads,
// the session insert and the 'shown' events insert on top, 15s cut it close
// on a slow decider call, so this carries margin above the decider budget.
export const maxDuration = 20;

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;

// ---------------------------------------------------------------------------
// Menu + traits + popularity: in-memory, per-instance, 60s cache (§5's
// architecture diagram: "[cache 60 s]"). A stale-by-a-minute menu is a
// non-issue for a suggestion; a Supabase round trip on every keystroke of a
// wizard is.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

let menuCache: { at: number; items: MenuItem[]; traitsById: Map<string, MenuItemTraits> } | null = null;
let popularityCache: { at: number; map: Map<string, number> } | null = null;

async function loadMenuAndTraits(admin: AdminClient): Promise<{ items: MenuItem[]; traitsById: Map<string, MenuItemTraits> }> {
  if (menuCache && Date.now() - menuCache.at < CACHE_TTL_MS) return menuCache;

  const [menuResult, traitsResult] = await Promise.all([
    admin.from('menu_items').select(MENU_ITEM_SELECT).eq('is_available', true),
    admin.from('menu_item_traits').select('*'),
  ]);
  if (menuResult.error) {
    console.error('suggest route: menu load failed', menuResult.error);
    return { items: [], traitsById: new Map() };
  }
  if (traitsResult.error) {
    console.error('suggest route: traits load failed', traitsResult.error);
  }

  const items = (menuResult.data ?? []).map((row) => shapeMenuItem(row as unknown as MenuItemRow));
  const traitsById = new Map<string, MenuItemTraits>(
    ((traitsResult.data ?? []) as MenuItemTraits[]).map((t) => [t.menu_item_id, t]),
  );

  menuCache = { at: Date.now(), items, traitsById };
  return menuCache;
}

/** 30-day units sold, across the whole menu (§5.3 popularity term). */
async function loadPopularity30d(admin: AdminClient): Promise<Map<string, number>> {
  if (popularityCache && Date.now() - popularityCache.at < CACHE_TTL_MS) return popularityCache.map;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('order_items')
    .select('menu_item_id, quantity, voided, orders!inner(status, created_at)')
    .gte('orders.created_at', since)
    .not('orders.status', 'in', '("rejected","cancelled")');
  if (error) {
    console.error('suggest route: popularity load failed', error);
    return new Map();
  }

  const map = new Map<string, number>();
  for (const row of (data ?? []) as { menu_item_id: string | null; quantity: number; voided: boolean }[]) {
    if (!row.menu_item_id || row.voided) continue;
    map.set(row.menu_item_id, (map.get(row.menu_item_id) ?? 0) + row.quantity);
  }
  popularityCache = { at: Date.now(), map };
  return map;
}

async function loadRecentItemIds(admin: AdminClient, userId: string | null): Promise<string[]> {
  if (!userId) return [];
  const { data, error } = await admin
    .from('orders')
    .select('order_items(menu_item_id)')
    .or(`user_id.eq.${userId},customer_user_id.eq.${userId}`)
    .not('status', 'in', '("rejected","cancelled")')
    .order('created_at', { ascending: false })
    .limit(3);
  if (error) {
    console.error('suggest route: recent items load failed', error);
    return [];
  }
  const ids = new Set<string>();
  for (const row of (data ?? []) as { order_items: { menu_item_id: string | null }[] | null }[]) {
    for (const line of row.order_items ?? []) {
      if (line.menu_item_id) ids.add(line.menu_item_id);
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Refine chain
// ---------------------------------------------------------------------------

interface ParentSessionRow {
  id: string;
  user_id: string | null;
  anon_id: string | null;
  refine_of: string | null;
  created_at: string;
}

function ownsSession(session: ParentSessionRow, userId: string | null, anonId: string | undefined): boolean {
  if (session.user_id) return session.user_id === userId;
  if (session.anon_id) return Boolean(anonId) && session.anon_id === anonId;
  return true;
}

function tooOld(createdAt: string, now: Date): boolean {
  return now.getTime() - new Date(createdAt).getTime() > SUGGEST_LIMITS.eventSessionMaxAgeHours * 60 * 60 * 1000;
}

/** How many refine_of hops already exist ABOVE `sessionId` (root = 0). */
async function ancestorDepth(admin: AdminClient, sessionId: string): Promise<number> {
  let depth = 0;
  let currentId: string | null = sessionId;
  for (let i = 0; i < SUGGEST_LIMITS.refines + 2 && currentId; i++) {
    const result = await admin.from('suggestion_sessions').select('refine_of').eq('id', currentId).maybeSingle();
    const row = result.data as unknown as { refine_of: string | null } | null;
    const refineOf: string | null = row?.refine_of ?? null;
    if (!refineOf) break;
    depth++;
    currentId = refineOf;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// POST /api/suggest
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  if (!flags.suggest) {
    return errorResponse(404, 'Not found');
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }
  const parsed = validateSuggestRequest(body);
  if (typeof parsed === 'string') {
    return errorResponse(400, parsed);
  }

  const now = new Date();
  const admin = createAdminSupabaseClient();
  const sessionUser = await getAuthUser();
  const userId = sessionUser?.id ?? null;

  // §5.6 rate limits — over limit ⇒ still answer, deterministic only, never refused.
  const ip = clientIp(request);
  const [ipOk, userOk] = await Promise.all([
    rateLimitOk(`suggest:ip:${ip}`, SUGGEST_LIMITS.ipRequestsPer10Min, 600),
    userId ? rateLimitOk(`suggest:user:${userId}`, SUGGEST_LIMITS.userRequestsPerDay, 86400) : Promise.resolve(true),
  ]);
  const rateLimited = !ipOk || !userOk;

  // Refine chain (§3.2 "Show me something different", max SUGGEST_LIMITS.refines).
  let refineChainDepth = 0;
  if (parsed.refineOf) {
    const { data: parentRow, error: parentError } = await admin
      .from('suggestion_sessions')
      .select('id, user_id, anon_id, refine_of, created_at')
      .eq('id', parsed.refineOf)
      .maybeSingle();
    const parent = (parentError ? null : (parentRow as ParentSessionRow | null)) ?? null;
    if (!parent || tooOld(parent.created_at, now) || !ownsSession(parent, userId, parsed.anonId)) {
      return errorResponse(404, 'That suggestion session was not found or has expired');
    }

    const parentDepth = await ancestorDepth(admin, parent.id);
    if (parentDepth >= SUGGEST_LIMITS.refines) {
      // No refines left — a polite, fallback-free "browse the menu" state.
      // Nothing new is computed or persisted; the parent session id is
      // reused since nothing about it changed.
      const noMoreRefines: SuggestResponse = {
        sessionId: parent.id,
        header: "You've seen all our fresh ideas for this round — the whole menu is worth a browse too ☕",
        usual: null,
        picks: [],
        source: 'fallback',
        relaxHint: null,
        refinesLeft: 0,
        items: [],
      };
      return NextResponse.json(noMoreRefines);
    }
    refineChainDepth = parentDepth + 1;
  }

  // §5.6 spend cap + kill switch + rate limit ⇒ whether an LLM call happens at all.
  let decider: Decider | null = null;
  let preDecidedFallbackReason: FallbackReason | undefined;
  if (rateLimited) {
    preDecidedFallbackReason = 'rate_limited';
  } else if (!llmEnabled()) {
    preDecidedFallbackReason = llmDisabledReason() ?? 'no_key';
  } else {
    const spent = await todaySpendMicros(now);
    if (isOverBudget(spent, dailyBudgetUsdMicros())) {
      preDecidedFallbackReason = 'budget';
    } else {
      decider = activeDecider();
    }
  }

  const [{ items: menu, traitsById }, popularity, recentItemIds] = await Promise.all([
    loadMenuAndTraits(admin),
    loadPopularity30d(admin),
    loadRecentItemIds(admin, userId),
  ]);

  let profile = null;
  if (userId) {
    const profileResult = await getOrBuildProfile(userId, now);
    profile = profileResult.optedOut ? null : profileResult.profile;
  }

  const result = await runSuggest({
    request: parsed,
    menu,
    traitsById,
    profile,
    popularity,
    recentItemIds,
    now,
    decider,
    fallbackReason: preDecidedFallbackReason,
  });

  // Persist the session + 'shown' events (§7). Best-effort: an insert failure
  // never blocks the response — a generated id is used and events are simply
  // skipped (they'd violate the session_id FK anyway).
  let sessionId = crypto.randomUUID();
  let persisted = false;
  const { data: inserted, error: insertError } = await admin
    .from('suggestion_sessions')
    .insert({
      user_id: userId,
      anon_id: parsed.anonId ?? null,
      inputs: parsed.inputs,
      profile_used: profile !== null,
      ordering_mood: profile?.orderingMood ?? null,
      candidate_ids: result.candidateIds,
      pick_ids: result.pickIds,
      usual_item_id: result.usualItemId,
      source: result.source,
      fallback_reason: result.fallbackReason,
      model: result.usage.model,
      latency_ms: result.latencyMs,
      input_tokens: result.usage.inputTokens,
      cache_read_tokens: result.usage.cacheReadTokens,
      output_tokens: result.usage.outputTokens,
      cost_usd_micros: result.usage.costUsdMicros,
      refine_of: parsed.refineOf ?? null,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    console.error('suggest route: session insert failed — returning suggestions without persistence', insertError);
  } else {
    sessionId = inserted.id as string;
    persisted = true;
  }

  if (persisted) {
    const shownIds = [...(result.usualItemId ? [result.usualItemId] : []), ...result.pickIds];
    if (shownIds.length > 0) {
      const { error: eventsError } = await admin
        .from('suggestion_events')
        .insert(shownIds.map((menuItemId) => ({ session_id: sessionId, event: 'shown', menu_item_id: menuItemId })));
      if (eventsError) console.error('suggest route: shown events insert failed (best-effort)', eventsError);
    }
  }

  const refinesLeft = Math.max(0, SUGGEST_LIMITS.refines - refineChainDepth);

  const response: SuggestResponse = {
    sessionId,
    header: result.header || templateHeader(parsed.inputs.mood),
    usual: result.usual,
    picks: result.picks,
    source: result.source,
    relaxHint: result.relaxHint,
    refinesLeft,
    items: result.items,
  };

  return NextResponse.json(response);
}
