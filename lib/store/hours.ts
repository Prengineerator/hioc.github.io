// Pure store-hours / pickup-slot / bill math (O5, C3, C4, C5).
// No DB or Supabase imports — safe to use on the server (authoritative order
// pricing + open check) AND in client components (checkout slot picker, GST
// preview, closed banner). All wall-clock reasoning is in Asia/Kolkata (IST),
// matching lib/api/date.ts.

import type { OpeningHoursWindow, StoreSettings } from '@/lib/types';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

// A Date's wall-clock fields as seen in IST (regardless of server tz).
function istParts(at: Date) {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    y: ist.getUTCFullYear(),
    mo: ist.getUTCMonth(),
    d: ist.getUTCDate(),
    dow: ist.getUTCDay(),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    isoDate: `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(
      ist.getUTCDate(),
    ).padStart(2, '0')}`,
  };
}

// 'HH:MM' (or '24:00') → minutes since midnight. '24:00' → 1440.
function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return h * 60 + (m || 0);
}

// Minutes-since-IST-midnight of a given day → the equivalent UTC Date.
function istMinutesToUtc(y: number, mo: number, d: number, minutes: number): Date {
  return new Date(Date.UTC(y, mo, d, 0, 0, 0) - IST_OFFSET_MS + minutes * 60_000);
}

export function formatIstTime(at: Date): string {
  const { minutes } = istParts(at);
  let h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

export interface StoreOpenState {
  isOpen: boolean;
  acceptingOrders: boolean; // isOpen AND not paused AND before last-order cutoff
  reason: 'open' | 'paused' | 'closed_hours' | 'holiday' | 'forced_closed' | 'after_cutoff';
  nextOpenLabel: string | null;
}

function windowsFor(settings: StoreSettings, dow: number): OpeningHoursWindow[] {
  return settings.opening_hours[WEEKDAYS[dow]] ?? [];
}

/**
 * Authoritative "is the store open / accepting orders right now" (C3, S7).
 * Honors manual override (force_open/force_closed beats schedule), holidays,
 * the accepting_orders pause switch, and the last-order cutoff.
 */
export function computeStoreOpenState(
  settings: StoreSettings,
  now: Date = new Date(),
): StoreOpenState {
  const { dow, minutes, isoDate } = istParts(now);

  if (settings.store_open_override === 'force_closed') {
    return { isOpen: false, acceptingOrders: false, reason: 'forced_closed', nextOpenLabel: null };
  }

  const onHoliday = settings.holidays.includes(isoDate);
  const forcedOpen = settings.store_open_override === 'force_open';

  const openWindow = windowsFor(settings, dow).find((w) => {
    const close = hhmmToMin(w.close);
    return minutes >= hhmmToMin(w.open) && minutes < close;
  });

  const scheduledOpen = !onHoliday && Boolean(openWindow);
  const isOpen = forcedOpen || scheduledOpen;

  if (!isOpen) {
    return {
      isOpen: false,
      acceptingOrders: false,
      reason: onHoliday ? 'holiday' : 'closed_hours',
      nextOpenLabel: null,
    };
  }

  if (!settings.accepting_orders) {
    return { isOpen: true, acceptingOrders: false, reason: 'paused', nextOpenLabel: null };
  }

  // Last-order cutoff (stop taking orders N min before the scheduled close)
  // applies only to schedule-driven opening. A manual force_open is an explicit
  // "take orders now" override by the owner, so it bypasses the cutoff — without
  // this, force_open couldn't actually accept orders near closing time.
  if (!forcedOpen && openWindow) {
    const closeMin = hhmmToMin(openWindow.close);
    if (minutes >= closeMin - settings.last_order_cutoff_min) {
      return { isOpen: true, acceptingOrders: false, reason: 'after_cutoff', nextOpenLabel: null };
    }
  }

  return { isOpen: true, acceptingOrders: true, reason: 'open', nextOpenLabel: null };
}

export interface PickupSlot {
  start: string; // ISO UTC; '' for the ASAP pseudo-slot
  label: string; // 'ASAP (~15 min)', '1:30 PM', …
  isAsap: boolean;
}

/**
 * Structured pickup slots for the checkout picker (C4/CUS-026): an ASAP option
 * (default_prep_min out) followed by slot_len-minute slots up to the store's
 * close for the current day. Only future, in-hours slots are returned; capacity
 * is enforced server-side against booked counts (not here — pure/DB-free).
 */
export function generatePickupSlots(
  settings: StoreSettings,
  now: Date = new Date(),
): PickupSlot[] {
  const slots: PickupSlot[] = [];
  const state = computeStoreOpenState(settings, now);
  if (!state.acceptingOrders) return slots;

  const { y, mo, d, dow, minutes } = istParts(now);
  const window = windowsFor(settings, dow).find((w) => {
    const close = hhmmToMin(w.close);
    return minutes >= hhmmToMin(w.open) && minutes < close;
  });
  if (!window) return slots;

  slots.push({
    start: '',
    label: `ASAP (~${settings.default_prep_min} min)`,
    isAsap: true,
  });

  const len = Math.max(5, settings.pickup_slot_len_min);
  const closeMin = hhmmToMin(window.close) - settings.last_order_cutoff_min;
  // First slot is the next slot boundary at least default_prep_min out.
  let slotMin = Math.ceil((minutes + settings.default_prep_min) / len) * len;
  for (; slotMin <= closeMin; slotMin += len) {
    const startUtc = istMinutesToUtc(y, mo, d, slotMin);
    slots.push({ start: startUtc.toISOString(), label: formatIstTime(startUtc), isAsap: false });
  }
  return slots;
}

export interface BillBreakdown {
  subtotal_inr: number;
  tax_inr: number;
  packaging_inr: number;
  discount_inr: number;
  total_inr: number;
}

/**
 * Authoritative bill math from a server-computed subtotal (C5/CUS-031).
 * GST rounds to the nearest integer ₹ (repo-wide integer-₹ convention). When
 * gst_inclusive is true the GST is extracted from the subtotal rather than
 * added on top, so the grand total equals the subtotal.
 */
export function computeBill(
  subtotalInr: number,
  settings: StoreSettings,
  discountInr = 0,
): BillBreakdown {
  const rate = settings.gst_percent / 100;
  const packaging = settings.packaging_charge_inr;

  if (settings.gst_inclusive) {
    const base = subtotalInr / (1 + rate);
    const tax = Math.round(subtotalInr - base);
    return {
      subtotal_inr: subtotalInr,
      tax_inr: tax,
      packaging_inr: packaging,
      discount_inr: discountInr,
      total_inr: subtotalInr + packaging - discountInr,
    };
  }

  const tax = Math.round(subtotalInr * rate);
  return {
    subtotal_inr: subtotalInr,
    tax_inr: tax,
    packaging_inr: packaging,
    discount_inr: discountInr,
    total_inr: subtotalInr + tax + packaging - discountInr,
  };
}

// Default settings used when the store_settings row can't be read (fail-safe
// so checkout/pricing never hard-crash). Mirrors migration §7 defaults + the
// cafe's real hours (lib/constants.ts CAFE_HOURS: 10:00–24:00 daily).
export const FALLBACK_STORE_SETTINGS: StoreSettings = {
  id: '00000000-0000-0000-0000-000000000000',
  is_singleton: true,
  opening_hours: {
    mon: [{ open: '10:00', close: '24:00' }],
    tue: [{ open: '10:00', close: '24:00' }],
    wed: [{ open: '10:00', close: '24:00' }],
    thu: [{ open: '10:00', close: '24:00' }],
    fri: [{ open: '10:00', close: '24:00' }],
    sat: [{ open: '10:00', close: '24:00' }],
    sun: [{ open: '10:00', close: '24:00' }],
  },
  holidays: [],
  last_order_cutoff_min: 30,
  pickup_slot_len_min: 15,
  pickup_slot_capacity: 0,
  default_prep_min: 15,
  busy_buffer_min: 15,
  accepting_orders: true,
  store_open_override: 'auto',
  gst_percent: 5,
  gst_inclusive: false,
  packaging_charge_inr: 0,
  updated_at: new Date(0).toISOString(),
};
