// Who a "customer" is, for the retention and coupon downloads (Owner → Reports →
// Downloads → Loyalty, promotions & retention). Pure: the server loader
// (retentionReportsServer.ts) reads the rows, this file decides whose they are.
//
// One PERSON, in order of preference:
//   1. the account the order belongs to, customer_user_id before user_id
//      (lib/loyalty/beneficiary.ts loyaltyUserIdFor, the rule that decides whose
//      Beanies an order moves) — unless that account is staff, owner or manager,
//      who are not customers;
//   2. else the phone on the order, as 'p:+91XXXXXXXXXX'. A phone that is the
//      VERIFIED phone of a customer account joins that account instead (the rule
//      of lib/loyalty/customerLink.ts: profiles.phone is free text until an OTP
//      has verified it, so an unverified match proves nothing). A phone two
//      accounts both claim joins neither; a staff phone is nobody;
//   3. else nobody — a walk-in the café cannot follow.
// Phones are compared the way orderMatchFilter compares them: '+91XXXXXXXXXX' and
// the bare ten digits some older orders keep are one number (lib/phone.ts, which
// also refuses a foreign '+' number rather than reading it as Indian).
//
// FIRST VISIT EVER = the earliest of the person's valid app orders and their
// Petpooja history (legacy_customers.first_order_at, plus any Petpooja bill read).
// The app took over from Petpooja on 25 Sep 2026; without folding that history in,
// every old regular's first app order would look like a brand-new customer.
// "New in a period" = first visit ever falls in it; everyone else is "returning".
// A VISIT is a day (IST) with at least one bill, so two bills in one sitting are
// one visit — the unit lib/marketing/segments.ts typicalGapDays also uses.

import { loyaltyUserIdFor } from '@/lib/loyalty/beneficiary';
import { isValidOrderStatus } from '@/lib/marketing/segments';
import { indianE164HonouringPlus } from '@/lib/phone';
import { istDateOf } from '@/lib/reports/reconcile';

/** How far before a report's first day the loaders look for earlier visits. */
export const LOOKBACK_MONTHS = 12;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' moved by whole months, the day kept (or cut to the month's last day: 31 Mar − 1 → 28 Feb). */
export function addMonthsToDate(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12; // 0-based
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${pad2(month + 1)}-${pad2(Math.min(d, last))}`;
}

/** The first IST day the loaders read for a report starting on `from`. */
export function lookbackFrom(from: string): string {
  return addMonthsToDate(from, -LOOKBACK_MONTHS);
}

// ── Rows, as the server loads them ───────────────────────────────────────────

/** profiles, the columns identity needs. */
export interface ProfileRow {
  id: string;
  name: string | null;
  phone: string | null;
  phone_verified: boolean | null;
  /** customer | staff | manager | owner; null reads as a customer. */
  role: string | null;
}

/** An app order, identity columns only. */
export interface AppOrderRow {
  id: string;
  order_number: number;
  created_at: string;
  status: string;
  channel: string;
  user_id: string | null;
  /** Absent before 2026-08-counter-loyalty.sql. */
  customer_user_id?: string | null;
  customer_phone?: string | null;
  customer_name?: string | null;
  total_inr: number | null;
  discount_inr?: number | null;
}

/** A completed Petpooja bill that carries a phone (legacy_orders). */
export interface LegacyBillRow {
  customer_phone: string | null;
  ordered_at: string;
  total_inr: number | null;
}

/** One Petpooja customer (legacy_customers; completed bills only). */
export interface LegacyCustomerRow {
  phone: string;
  name?: string | null;
  first_order_at: string | null;
  last_order_at: string | null;
  order_count: number | null;
  total_spend_inr?: number | null;
}

// ── Phones and accounts ──────────────────────────────────────────────────────

/** Any spelling of an Indian mobile → '+91XXXXXXXXXX'; null for anything else (empty, foreign, malformed). */
export function toCustomerPhone(raw: string | null | undefined): string | null {
  return indianE164HonouringPlus(raw ?? '');
}

export const PHONE_KEY_PREFIX = 'p:';

/** The person key of someone known only by phone. */
export const phoneKey = (e164: string): string => `${PHONE_KEY_PREFIX}${e164}`;

/** True for a phone-only person (no account). */
export const isPhoneKey = (key: string): boolean => key.startsWith(PHONE_KEY_PREFIX);

/** Staff, managers and the owner are not customers; a missing role is a customer. */
export const isStaffRole = (role: string | null | undefined): boolean => !!role && role !== 'customer';

/** What identity reads off an order. */
export interface OrderIdentity {
  user_id?: string | null;
  customer_user_id?: string | null;
  customer_phone?: string | null;
}

export interface IdentityResolver {
  /** The person an order belongs to; null for a walk-in, or for an order only a staff account/phone is on. */
  keyForOrder(o: OrderIdentity): string | null;
  /** The person behind a bare phone (a Petpooja bill); null when it is not a usable customer number. */
  keyForPhone(raw: string | null | undefined): string | null;
  isStaffAccount(id: string): boolean;
  /** A number on a staff, manager or owner profile. */
  isStaffPhone(phone: string): boolean;
  profile(id: string): ProfileRow | undefined;
  /** The account's OTP-verified phone, E.164. */
  verifiedPhone(accountId: string): string | null;
}

/** Builds the resolver from every profile the loader read: the account holders and ALL the staff. */
export function createIdentityResolver(profiles: readonly ProfileRow[]): IdentityResolver {
  const byId = new Map<string, ProfileRow>();
  const staffIds = new Set<string>();
  const staffPhones = new Set<string>();
  const accountByPhone = new Map<string, string>();
  const claimedTwice = new Set<string>();

  for (const p of profiles) {
    if (byId.has(p.id)) continue;
    byId.set(p.id, p);
    const phone = toCustomerPhone(p.phone);
    if (isStaffRole(p.role)) {
      staffIds.add(p.id);
      // Any staff number counts, verified or not: it is the café's own phone, not a guest's.
      if (phone) staffPhones.add(phone);
      continue;
    }
    if (phone && p.phone_verified) {
      const holder = accountByPhone.get(phone);
      if (holder && holder !== p.id) claimedTwice.add(phone);
      else accountByPhone.set(phone, p.id);
    }
  }

  const keyForPhone = (raw: string | null | undefined): string | null => {
    const phone = toCustomerPhone(raw);
    if (!phone || staffPhones.has(phone)) return null;
    const account = accountByPhone.get(phone);
    return account && !claimedTwice.has(phone) ? account : phoneKey(phone);
  };

  return {
    keyForOrder(o) {
      const account = loyaltyUserIdFor(o);
      if (account && !staffIds.has(account)) return account;
      return keyForPhone(o.customer_phone);
    },
    keyForPhone,
    isStaffAccount: (id) => staffIds.has(id),
    isStaffPhone: (phone) => staffPhones.has(phone),
    profile: (id) => byId.get(id),
    verifiedPhone(accountId) {
      const p = byId.get(accountId);
      return p && p.phone_verified && !isStaffRole(p.role) ? toCustomerPhone(p.phone) : null;
    },
  };
}

// ── People and their visits ──────────────────────────────────────────────────

/** One bill, as a visit. */
export interface Visit {
  /** ISO instant. */
  at: string;
  /** IST date of `at`. */
  date: string;
  totalInr: number;
  source: 'app' | 'petpooja';
  /** The app order's id; null for a Petpooja bill. */
  orderId: string | null;
}

/** What legacy_customers says about a person's Petpooja years (all time). */
export interface LegacyHistory {
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  /** Completed Petpooja bills. */
  orderCount: number;
}

export interface Person {
  /** Account id, or 'p:+91…'. */
  key: string;
  accountId: string | null;
  /** Profile name, else the name last typed on an order, else the Petpooja name; '' when none. */
  name: string;
  /** For display (the sheets mask it); '' when unknown. */
  phone: string;
  /** Numbers that identify the person — the account's verified phone, or the phone-only key's phone. Petpooja history is matched on these. */
  phones: string[];
  /** Valid app orders and Petpooja bills read, oldest first. */
  visits: Visit[];
  legacy: LegacyHistory | null;
  /** Petpooja bills among `visits`. */
  legacyBillsRead: number;
  /** Earliest of the visits read and legacy_customers.first_order_at. ISO. */
  firstVisitAt: string;
  /** IST date of firstVisitAt. */
  firstVisitDate: string;
}

export interface CustomerBook {
  resolver: IdentityResolver;
  people: Map<string, Person>;
  /** The person for every app order given, valid or not; null = walk-in. */
  keyByOrderId: Map<string, string | null>;
}

export interface BookInput {
  profiles: readonly ProfileRow[];
  /** App orders of any status; only the valid ones make visits. */
  orders: readonly AppOrderRow[];
  legacyBills: readonly LegacyBillRow[];
  legacyCustomers: readonly LegacyCustomerRow[];
}

const ms = (iso: string): number => Date.parse(iso);
const asNumber = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

interface Draft {
  key: string;
  accountId: string | null;
  name: string;
  nameAt: number;
  typedPhone: string;
  typedPhoneAt: number;
  visits: Visit[];
  legacyBillsRead: number;
}

/** Joins orders, Petpooja bills and profiles into people. */
export function buildCustomerBook(input: BookInput): CustomerBook {
  const resolver = createIdentityResolver(input.profiles);
  const legacyByPhone = new Map<string, LegacyCustomerRow>();
  for (const lc of input.legacyCustomers) {
    const phone = toCustomerPhone(lc.phone);
    if (phone) legacyByPhone.set(phone, lc);
  }

  const drafts = new Map<string, Draft>();
  const draftFor = (key: string): Draft => {
    let d = drafts.get(key);
    if (!d) {
      d = {
        key,
        accountId: isPhoneKey(key) ? null : key,
        name: '',
        nameAt: -Infinity,
        typedPhone: '',
        typedPhoneAt: -Infinity,
        visits: [],
        legacyBillsRead: 0,
      };
      drafts.set(key, d);
    }
    return d;
  };

  const keyByOrderId = new Map<string, string | null>();
  for (const o of input.orders) {
    const key = resolver.keyForOrder(o);
    keyByOrderId.set(o.id, key);
    if (!key || !isValidOrderStatus(o.status)) continue;
    const d = draftFor(key);
    const at = ms(o.created_at);
    d.visits.push({ at: o.created_at, date: istDateOf(o.created_at), totalInr: asNumber(o.total_inr), source: 'app', orderId: o.id });
    const name = (o.customer_name ?? '').trim();
    if (name && at >= d.nameAt) {
      d.name = name;
      d.nameAt = at;
    }
    const phone = toCustomerPhone(o.customer_phone);
    if (phone && !resolver.isStaffPhone(phone) && at >= d.typedPhoneAt) {
      d.typedPhone = phone;
      d.typedPhoneAt = at;
    }
  }

  for (const b of input.legacyBills) {
    const key = resolver.keyForPhone(b.customer_phone);
    if (!key) continue;
    const d = draftFor(key);
    d.visits.push({ at: b.ordered_at, date: istDateOf(b.ordered_at), totalInr: asNumber(b.total_inr), source: 'petpooja', orderId: null });
    d.legacyBillsRead += 1;
  }

  const people = new Map<string, Person>();
  for (const d of drafts.values()) {
    if (d.visits.length === 0) continue;
    d.visits.sort((a, b) => ms(a.at) - ms(b.at));

    const profile = d.accountId ? resolver.profile(d.accountId) : undefined;
    const verified = d.accountId ? resolver.verifiedPhone(d.accountId) : null;
    const phones = d.accountId ? (verified ? [verified] : []) : [d.key.slice(PHONE_KEY_PREFIX.length)];

    const legacyRows = phones.map((p) => legacyByPhone.get(p)).filter((r): r is LegacyCustomerRow => !!r);
    let legacy: LegacyHistory | null = null;
    if (legacyRows.length > 0) {
      const firsts = legacyRows.map((r) => r.first_order_at).filter((v): v is string => !!v);
      const lasts = legacyRows.map((r) => r.last_order_at).filter((v): v is string => !!v);
      legacy = {
        firstOrderAt: firsts.length ? firsts.reduce((a, b) => (ms(a) <= ms(b) ? a : b)) : null,
        lastOrderAt: lasts.length ? lasts.reduce((a, b) => (ms(a) >= ms(b) ? a : b)) : null,
        orderCount: legacyRows.reduce((s, r) => s + asNumber(r.order_count), 0),
      };
    }

    const earliest = [d.visits[0].at, legacy?.firstOrderAt].filter((v): v is string => !!v).reduce((a, b) => (ms(a) <= ms(b) ? a : b));
    const accountPhone = profile ? toCustomerPhone(profile.phone) : null;

    people.set(d.key, {
      key: d.key,
      accountId: d.accountId,
      name: (profile?.name ?? '').trim() || d.name || (legacyRows.find((r) => (r.name ?? '').trim())?.name ?? '').trim(),
      phone: d.accountId ? (accountPhone ?? d.typedPhone) : phones[0],
      phones,
      visits: d.visits,
      legacy,
      legacyBillsRead: d.legacyBillsRead,
      firstVisitAt: new Date(ms(earliest)).toISOString(),
      firstVisitDate: istDateOf(earliest),
    });
  }

  return { resolver, people, keyByOrderId };
}

/**
 * E.164 numbers behind app orders from `sinceIso` on: the numbers typed on them and
 * the verified phone of their accounts. The people who must NOT be called lapsed
 * Petpooja regulars (lib/legacy/ownerStats.ts isLapsedRegular's `recentAppPhones`).
 */
export function appPhonesSince(orders: readonly AppOrderRow[], resolver: IdentityResolver, sinceIso: string): Set<string> {
  const out = new Set<string>();
  const since = ms(sinceIso);
  for (const o of orders) {
    if (!isValidOrderStatus(o.status) || ms(o.created_at) < since) continue;
    const phone = toCustomerPhone(o.customer_phone);
    if (phone) out.add(phone);
    const account = loyaltyUserIdFor(o);
    const verified = account && !resolver.isStaffAccount(account) ? resolver.verifiedPhone(account) : null;
    if (verified) out.add(verified);
  }
  return out;
}
