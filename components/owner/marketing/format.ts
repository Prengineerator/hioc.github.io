// Display helpers for the marketing dashboard. Pure (no React, no DOM) so the
// rules are unit-tested once (tests/marketingDashboardFormat.test.ts).
//
// Units are the ones documented at the top of lib/marketing/types.ts, and the
// mix-ups that matter are handled HERE so no component has to remember them:
//   *_pct  0–100   → formatPercent()
//   *_rate 0–1     → formatRate() / formatBreakEven()   (× 100 happens here, once)
//   lift_pp        → formatLift()   (percentage POINTS, not a percent)
//   roi            → formatRoi()    (a ratio: 4.02 = ₹4.02 back per ₹1)
//
// Everything is shown in IST (Asia/Kolkata) with plain arithmetic instead of
// Intl.DateTimeFormat, so the output never depends on the browser's timezone or
// ICU build (the same reason lib/marketing/ist.ts avoids Intl).

import { inr } from '@/components/owner/dashboard';
import { IST_OFFSET_MS, toMs, type Instant } from '@/lib/marketing/ist';
import { formatShortDate } from '@/lib/marketing/templates';
import {
  DEFAULT_MARKETING_TAB,
  isMarketingTab,
  type CampaignStatus,
  type ConsentSource,
  type GuardrailFlag,
  type MarketingTab,
  type RecipientStatus,
} from '@/lib/marketing/types';

export { inr };

const MINUS = '−';

/** ₹ with up to 3 decimals and Indian grouping — for per-message costs: ₹1.02, ₹0.14, ₹1,234.5. */
export function inrExact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  return `${n < 0 ? MINUS : ''}₹${abs}`;
}

/** Whole ₹ that may be negative, with a real minus sign: −₹120. */
export function signedInr(n: number): string {
  if (!Number.isFinite(n)) return '—';
  // `|| 0` turns a rounded -0 into 0: (-0).toLocaleString() prints "-0", which would show as "₹-0".
  const rounded = Math.round(n) || 0;
  return rounded < 0 ? `${MINUS}${inr(-rounded)}` : inr(rounded);
}

/** A whole number with Indian digit grouping: 12,345. */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-IN') : '—';
}

/** A 0–100 percentage: 12%, 12.5% (decimals only when asked for). */
export function formatPercent(pct: number | null | undefined, decimals = 0): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  // "12.0%" reads as false precision next to "12%": drop a trailing .0 (but keep 12.5).
  return `${pct.toFixed(decimals).replace(/\.0+$/, '')}%`;
}

/** A 0–1 rate shown as a percentage: 0.12 → 12%. */
export function formatRate(rate: number | null | undefined, decimals = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return formatPercent(rate * 100, decimals);
}

/**
 * The break-even conversion as a % (spec §1.6: shown as a %, not a rate):
 * "0.65%" for the worked example. More decimals when it is tiny, because
 * "1%" and "0.6%" mean very different things for a 200-person campaign.
 * null means the campaign can never pay for itself (profit per order ≤ 0).
 */
export function formatBreakEven(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return 'Not reachable';
  const pct = rate * 100;
  if (pct > 0 && pct < 0.01) return '<0.01%';
  const decimals = pct >= 10 ? 0 : pct >= 1 ? 1 : 2;
  return `${pct.toFixed(decimals)}%`;
}

/** Expected returning orders: "about 19", "less than 1", "0". */
export function formatExpectedOrders(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1) return 'less than 1';
  return `about ${Math.round(n)}`;
}

/** ROI as a multiple: 4.02 → "4.0×", −0.4 → "−0.4×", null → "—". */
export function formatRoi(roi: number | null | undefined): string {
  if (roi === null || roi === undefined || !Number.isFinite(roi)) return '—';
  const s = Math.abs(roi).toFixed(1);
  return `${roi < 0 && s !== '0.0' ? MINUS : ''}${s}×`;
}

/** One plain sentence for what an ROI means, or '' when there is none. */
export function describeRoi(roi: number | null | undefined): string {
  if (roi === null || roi === undefined || !Number.isFinite(roi)) return '';
  if (roi >= 0) return `Every ₹1 spent is expected to bring back ₹${roi.toFixed(2)} of profit.`;
  return `Every ₹1 spent is expected to lose ₹${Math.abs(roi).toFixed(2)}.`;
}

/** Lift in percentage points: +4.2 points / −1.0 points; null = the holdout is too small to say. */
export function formatLift(pp: number | null | undefined): string {
  if (pp === null || pp === undefined || !Number.isFinite(pp)) return 'Not enough data yet';
  const s = Math.abs(pp).toFixed(1);
  const sign = pp > 0 && s !== '0.0' ? '+' : pp < 0 && s !== '0.0' ? MINUS : '';
  return `${sign}${s} points`;
}

/** Lift for a table cell: "+4.2 pts", or "—" while the holdout is too small to say. */
export function formatLiftShort(pp: number | null | undefined): string {
  if (pp === null || pp === undefined || !Number.isFinite(pp)) return '—';
  return formatLift(pp).replace(' points', ' pts');
}

// ---------------------------------------------------------------------------
// Dates and times (all IST)
// ---------------------------------------------------------------------------

/** "30 Sep" for an instant or a 'YYYY-MM-DD' IST date; '—' when missing or unparseable. */
export function formatIstDate(value: Instant | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const out = formatShortDate(value);
  return out || '—';
}

/** "11:05 am" — IST wall-clock time of an instant. */
export function formatIstClock(value: Instant): string {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + IST_OFFSET_MS);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'}`;
}

/** "30 Sep, 11:05 am" (IST); '—' when missing. */
export function formatIstDateTime(value: Instant | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = formatShortDate(value);
  if (!date) return '—';
  return `${date}, ${formatIstClock(value)}`;
}

/** An IST hour 0–24 as the owner says it: 0 → "12 midnight", 11 → "11 am", 12 → "12 noon", 20 → "8 pm", 24 → "12 midnight". */
export function hourLabel(hour: number): string {
  if (hour === 0 || hour === 24) return '12 midnight';
  if (hour === 12) return '12 noon';
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

/** "11 am to 8 pm IST" for a send window. */
export function describeSendWindow(startHour: number, endHour: number): string {
  return `${hourLabel(startHour)} to ${hourLabel(endHour)} IST`;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Short owner-facing names for the guardrail chips (the sentence comes from GUARDRAIL_EXPLANATIONS). */
export const GUARDRAIL_LABELS: Record<GuardrailFlag, string> = {
  negative_profit: 'Expected to lose money',
  low_margin: 'Thin margin',
  over_budget: 'Over budget',
  missing_costs: 'Product costs missing',
  no_template: 'No template',
  no_free_item: 'No free item',
};

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Waiting for your OK',
  approved: 'Approved, waiting to send',
  sending: 'Sending',
  completed: 'Done',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  pending: 'Waiting for approval',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  skipped: 'Skipped',
  holdout: 'Held back (to measure)',
  cancelled: 'Cancelled',
};

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** Pill colour for a campaign status. The label always carries the meaning; colour only reinforces it. */
export function campaignTone(status: CampaignStatus): Tone {
  switch (status) {
    case 'approved':
    case 'sending':
    case 'completed':
      return 'good';
    case 'draft':
    case 'pending_approval':
      return 'warn';
    case 'cancelled':
    case 'expired':
      return 'neutral';
  }
}

export function recipientTone(status: RecipientStatus): Tone {
  switch (status) {
    case 'sent':
    case 'delivered':
    case 'read':
      return 'good';
    case 'failed':
      return 'bad';
    case 'pending':
    case 'queued':
    case 'sending':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** Where a consent change came from, in words. Unknown sources fall back to the raw value. */
export const CONSENT_SOURCE_LABELS: Record<ConsentSource, string> = {
  profile: 'Account toggle or order page',
  whatsapp_keyword: 'Sent START on WhatsApp',
  stop_keyword: 'Replied STOP',
  stop_promotions: 'Tapped “Stop promotions”',
  meta_131050: 'WhatsApp blocked promotions (131050)',
  meta_stop: 'WhatsApp preference: stop',
  meta_resume: 'WhatsApp preference: resume',
  owner: 'You recorded it',
  backfill_profile: 'Earlier account tick-box',
  backfill_opt_out: 'Earlier STOP reply',
};

export function consentSourceLabel(source: string): string {
  return (CONSENT_SOURCE_LABELS as Record<string, string>)[source] ?? (source || 'Unknown');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * The tab named by a `?tab=` value. Unknown, missing or repeated values fall
 * back to Overview instead of rendering a blank page (a stale bookmark or a
 * typo must never strand the owner).
 */
export function tabFromParam(value: string | string[] | null | undefined): MarketingTab {
  const v = Array.isArray(value) ? value[0] : value;
  return isMarketingTab(v) ? v : DEFAULT_MARKETING_TAB;
}

/** The query string for a tab; Overview is the default so its URL stays clean. */
export function tabHref(pathname: string, tab: MarketingTab): string {
  return tab === DEFAULT_MARKETING_TAB ? pathname : `${pathname}?tab=${tab}`;
}
