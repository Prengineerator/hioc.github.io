// Who the agent can reason about: joins the raw tables into ContactStats (spec §1.1).
//
// A CONTACT is an E.164 phone. The population is every IDENTIFIED customer — a
// phone that has a verified account, an order, or a consent row — not only the
// opted-in ones, because "how many of my customers can I actually reach?" is a
// question the dashboard asks. Consent is a FLAG on the contact
// (consent_opted_in / opt_out_listed), and evaluateContact turns it into the
// not_opted_in reason. VIP is the exception: "top 20% by spend among contacts" (spec §1.1)
// is measured over the MESSAGEABLE ones, so a whale who never opted in — or a staff
// member's own orders — cannot raise the bar for the customers we can actually reach.
//
// A phone is linked to an account ONLY through a VERIFIED profile phone. The consent row's
// user_id is deliberately not a second link: it goes stale the day its user moves to a new
// verified number, and the old, recycled number would then inherit that account's orders,
// points and name ("Hi Asha, 120 points expire…" to a stranger).
//
// Order matching follows orderMatchFilter (lib/loyalty/customerLink.ts): an order
// belongs to a contact when its user_id or customer_user_id is the contact's account,
// OR its customer_phone matches — in either stored spelling ('+91XXXXXXXXXX' or the
// bare ten digits some older rows keep), which toE164 collapses to one.
//
// This file is pure joining. It loads through repo.ts (paged, abort-on-failure), then
// calls lib/marketing/segments for every number. Nothing here decides eligibility.

import 'server-only';
import { getLoyaltyConfig } from '@/lib/loyalty/ledger';
import type { ExpiryRow } from '@/lib/loyalty/expiry';
import {
  blendedFoodCost,
  learnedDeliverability,
  type FoodCostResult,
  type FreeItemVariantInput,
} from '@/lib/marketing/economics';
import { receiptsConnected, type PlanContact } from '@/lib/marketing/eligibility';
import { applyVip, buildContactStats, type OrderInput } from '@/lib/marketing/segments';
import {
  CONTACT_HISTORY_DAYS,
  DEFAULT_MAX_REDEEM_PCT,
  DEFAULT_SETTINGS,
  ECONOMICS_WINDOW_DAYS,
  defaultPlaybook,
} from '@/lib/marketing/types';
import type {
  ContactStats,
  MarketingSettings,
  PlaybookKey,
  PlaybookRow,
  SendHistoryEntry,
  WinbackParamsBundle,
  WinbackStage1Params,
  WinbackStage2Params,
  WinbackStage3Params,
} from '@/lib/marketing/types';
import { DAY_MS } from '@/lib/marketing/ist';
import {
  loadConsentRows,
  loadCostMap,
  loadFoodCostLines,
  loadLedger,
  loadMenuVariants,
  loadOptOutPhones,
  loadPlaybooks,
  loadSendHistory,
  loadSettings,
  loadStaffPhones,
  loadValidOrders,
  loadVerifiedProfiles,
  marketingAdmin,
  toE164,
  toFreeItemInputs,
  type Admin,
  type ConsentRow,
  type OrderRow,
} from './repo';

/** What the planner, the manual-campaign preview and the dashboard all price a campaign with. */
export interface EconomicsSnapshot {
  /** Mean order value over the last 90 days, integer ₹ — the basket fallback. */
  store_aov_inr: number;
  /** The blended food-cost ratio over the last 90 days of non-voided lines (spec §1.6 `f`). */
  food_cost: FoodCostResult;
  /** variant_id → entered cost. */
  costs: Map<string, number>;
  /** Every variant, with its cost when one is entered — what free-item ranking and pinning read. */
  variants: FreeItemVariantInput[];
  /** d — learned delivered ÷ sent when receipts flow, else 0.9. */
  deliverability: number;
}

export interface LoyaltySnapshot {
  points_expiry_days: number;
  inr_per_point: number;
  max_redeem_pct: number;
}

export interface AudienceSnapshot {
  now: Date;
  /** The stored settings, or the defaults when the singleton row is missing (then `settings_present` is false and enabled is false). */
  settings: MarketingSettings;
  settings_present: boolean;
  playbooks: PlaybookRow[];
  loyalty: LoyaltySnapshot;
  /** Every identified customer, opted in or not, with their marketing history. VIP is set over the messageable ones. */
  contacts: PlanContact[];
  /** Valid orders of the last 365 days (the weekly chart and the store AOV read these too). */
  orders: OrderRow[];
  /** Has any recipient ever reached delivered/read? false switches off the unread_pause rule. */
  receipts_connected: boolean;
  /** Every marketing_recipients entry of the last 365 days (deliverability and receipts are read from it). */
  history: SendHistoryEntry[];
  /** The whole consent ledger (the audience summary counts it by status and source). */
  consent: ConsentRow[];
  economics: EconomicsSnapshot;
}

/** The three win-back params objects, from whichever playbook rows are loaded (defaults for a missing one). */
export function winbackBundle(playbooks: readonly PlaybookRow[]): WinbackParamsBundle {
  const byKey = new Map<PlaybookKey, unknown>(playbooks.map((p) => [p.key, p.params]));
  return {
    winback_1: (byKey.get('winback_1') ?? defaultPlaybook('winback_1').params) as WinbackStage1Params,
    winback_2: (byKey.get('winback_2') ?? defaultPlaybook('winback_2').params) as WinbackStage2Params,
    winback_3: (byKey.get('winback_3') ?? defaultPlaybook('winback_3').params) as WinbackStage3Params,
  };
}

interface Person {
  phone: string;
  user_id: string | null;
  name: string | null;
  role: string | null;
  consent_opted_in: boolean;
  opt_out_listed: boolean;
}

/**
 * Everything the engine knows, joined once. One call = every table read once (all
 * paged), so a planner run, a dashboard load and a manual-campaign preview never
 * disagree about who a customer is.
 *
 * Throws MigrationMissingError when a marketing table is absent, and a plain Error
 * when a read fails: the planner must abort rather than plan from a partial picture.
 */
export async function buildContacts(now: Date, admin: Admin = marketingAdmin()): Promise<AudienceSnapshot> {
  const since365 = new Date(now.getTime() - CONTACT_HISTORY_DAYS * DAY_MS).toISOString();
  const since90 = new Date(now.getTime() - ECONOMICS_WINDOW_DAYS * DAY_MS).toISOString();

  // Settings and playbooks first: they throw MigrationMissingError before the heavy reads start.
  const storedSettings = await loadSettings(admin);
  const playbooks = await loadPlaybooks(admin);
  const settings = storedSettings ?? DEFAULT_SETTINGS;

  const [config, consentRows, optOuts, profiles, staffPhones, orders, ledger, history, costs, menu, lines] = await Promise.all([
    getLoyaltyConfig(),
    loadConsentRows(admin),
    loadOptOutPhones(admin),
    loadVerifiedProfiles(admin),
    loadStaffPhones(admin),
    loadValidOrders(since365),
    loadLedger(admin),
    loadSendHistory(admin, now),
    loadCostMap(admin),
    loadMenuVariants(admin),
    loadFoodCostLines(admin, since90),
  ]);

  const loyalty: LoyaltySnapshot = {
    points_expiry_days: config?.points_expiry_days ?? 0,
    inr_per_point: config?.inr_per_point ?? 1,
    max_redeem_pct: config?.max_redeem_pct ?? DEFAULT_MAX_REDEEM_PCT,
  };

  // ---- people: one per phone -------------------------------------------------
  const people = new Map<string, Person>();
  const person = (phone: string): Person => {
    let p = people.get(phone);
    if (!p) {
      p = { phone, user_id: null, name: null, role: null, consent_opted_in: false, opt_out_listed: false };
      people.set(phone, p);
    }
    return p;
  };

  for (const profile of profiles) {
    const phone = toE164(profile.phone);
    if (!phone) continue;
    const p = person(phone);
    p.user_id = profile.id;
    p.role = profile.role ?? 'customer';
    p.name = profile.name && profile.name.trim() ? profile.name : p.name;
  }
  for (const c of consentRows) {
    const phone = toE164(c.phone) ?? c.phone;
    const p = person(phone);
    p.consent_opted_in = c.status === 'opted_in';
  }
  for (const raw of optOuts) {
    const phone = toE164(raw);
    if (phone && people.has(phone)) people.get(phone)!.opt_out_listed = true;
  }
  // An opt-out for a phone with no other trace still makes it a (blocked) person, so it is never "unknown".
  for (const raw of optOuts) {
    const phone = toE164(raw);
    if (phone && !people.has(phone)) person(phone).opt_out_listed = true;
  }

  // ---- orders, indexed both ways --------------------------------------------
  const ordersByUser = new Map<string, OrderRow[]>();
  const ordersByPhone = new Map<string, OrderRow[]>();
  const push = (map: Map<string, OrderRow[]>, key: string, o: OrderRow) => {
    const list = map.get(key);
    if (list) list.push(o);
    else map.set(key, [o]);
  };
  for (const o of orders) {
    const users = new Set([o.user_id, o.customer_user_id].filter((u): u is string => Boolean(u)));
    for (const u of users) push(ordersByUser, u, o);
    const phone = toE164(o.customer_phone);
    if (phone) {
      push(ordersByPhone, phone, o);
      // A walk-in who gave a number at the counter is an identified customer even with no account.
      person(phone);
    }
  }

  // ---- staff -----------------------------------------------------------------
  // A staff phone is staff whether or not its profile is verified and whatever else knows the number
  // (an order, a consent row), so eligibility rule 2 keeps them out of playbooks AND manual campaigns.
  // Only phones that are already contacts need marking; a staff phone nothing else mentions never
  // becomes one. A real non-customer role (owner, manager) is kept as it is.
  for (const phone of staffPhones) {
    const p = people.get(phone);
    if (p && (p.role === null || p.role === 'customer')) p.role = 'staff';
  }

  // ---- stats -----------------------------------------------------------------
  const winback = winbackBundle(playbooks);
  const expiringDaysAhead = (playbooks.find((p) => p.key === 'points_expiring')?.params as { days_ahead: number } | undefined)?.days_ahead
    ?? defaultPlaybook('points_expiring').params.days_ahead;

  const stats: ContactStats[] = [];
  for (const p of people.values()) {
    const byPhone = ordersByPhone.get(p.phone) ?? [];
    const byUser = p.user_id ? ordersByUser.get(p.user_id) ?? [] : [];
    // buildContactStats de-duplicates by id, so an order that matches both ways counts once.
    const own = [...byUser, ...byPhone];
    const newest = own.reduce<OrderRow | null>((best, o) => (!best || o.created_at > best.created_at ? o : best), null);
    const orderInputs: OrderInput[] = own.map((o) => ({ id: o.id, created_at: o.created_at, total_inr: o.total_inr, status: o.status }));
    const pointsRows: ExpiryRow[] = p.user_id ? ledger.get(p.user_id) ?? [] : [];
    stats.push(
      buildContactStats(
        {
          phone: p.phone,
          user_id: p.user_id,
          name: p.name ?? newest?.customer_name ?? null,
          role: p.role,
          consent_opted_in: p.consent_opted_in,
          opt_out_listed: p.opt_out_listed,
          orders: orderInputs,
          points_rows: pointsRows,
        },
        {
          now,
          winback,
          points_expiry_days: loyalty.points_expiry_days,
          expiring_days_ahead: expiringDaysAhead,
          inr_per_point: loyalty.inr_per_point,
        },
      ),
    );
  }
  // The VIP bar is set over the contacts the agent can actually message (spec §1.1 "among contacts").
  const withVip = applyVip(stats, isMessageable);
  const contacts: PlanContact[] = withVip.map((s) => ({ stats: s, history: history.byPhone.get(s.phone) ?? [] }));

  // ---- economics inputs ------------------------------------------------------
  const recentOrders = orders.filter((o) => o.created_at >= since90);
  const storeAov = recentOrders.length ? Math.round(recentOrders.reduce((s, o) => s + o.total_inr, 0) / recentOrders.length) : 0;
  const foodCost = blendedFoodCost(lines, costs, settings.default_food_cost_pct);

  // Receipts flow → learn deliverability from messages old enough to have been delivered by now.
  // The denominator is EVERY treated row that left (sent_at set), the later-failed ones included:
  // Meta's 131049 ("not delivered to maintain ecosystem engagement") arrives asynchronously, after
  // 'sent', and the webhook then moves the row sent → failed while keeping its sent_at. Counting
  // only sent/delivered/read would drop exactly the messages that did not arrive and overstate reach.
  const connected = receiptsConnected(history.all);
  const oldEnoughMs = now.getTime() - DAY_MS;
  const sent = history.all.filter((e) => e.arm === 'treatment' && e.sent_at !== null && Date.parse(e.sent_at) <= oldEnoughMs);
  const delivered = sent.filter((e) => e.status === 'delivered' || e.status === 'read');

  return {
    now,
    settings,
    settings_present: storedSettings !== null,
    playbooks,
    loyalty,
    contacts,
    orders,
    receipts_connected: connected,
    history: history.all,
    consent: consentRows,
    economics: {
      store_aov_inr: storeAov,
      food_cost: foodCost,
      costs,
      variants: toFreeItemInputs(menu, costs),
      deliverability: learnedDeliverability(sent.length, delivered.length, connected),
    },
  };
}

/** Opted in, not on the opt-out list, and not staff: the people a campaign could actually reach. */
function isMessageable(c: Pick<ContactStats, 'consent_opted_in' | 'opt_out_listed' | 'role'>): boolean {
  return c.consent_opted_in && !c.opt_out_listed && (c.role === null || c.role === 'customer');
}

/** Contacts the agent may message at all: opted in, not on the opt-out list, not staff. */
export function messageableContacts(snapshot: AudienceSnapshot): PlanContact[] {
  return snapshot.contacts.filter((c) => isMessageable(c.stats));
}

