// Small pure helpers for the campaign drawer: reading the API's answer defensively,
// paging, and turning a recipient's status/skip-reason/error into one sentence.
// Unit-tested in tests/marketingDashboardFormat.test.ts.

import {
  MIN_HOLDOUT_FOR_LIFT,
  RECIPIENT_PAGE_SIZE,
  SKIP_REASON_LABELS,
  type CampaignDetail,
  type CampaignResults,
  type RecipientRow,
  type SkipReason,
} from '@/lib/marketing/types';
import { formatIstDateTime } from './format';

/**
 * GET /campaigns/[id] returns a CampaignDetail (spec §6), while the approve /
 * cancel / create calls return {campaign}. Accept either, so a route that wraps
 * the GET the same way as the writes doesn't blank the drawer.
 */
export function unwrapCampaignDetail(data: unknown): CampaignDetail | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { campaign?: unknown };
  const inner = d.campaign && typeof d.campaign === 'object' ? d.campaign : data;
  const c = inner as Partial<CampaignDetail>;
  return typeof c.id === 'string' && Array.isArray(c.recipients) && c.results ? (c as CampaignDetail) : null;
}

/** How many pages of RECIPIENT_PAGE_SIZE rows a total makes; at least 1 so "Page 1 of 1" reads right for an empty list. */
export function pageCount(total: number, pageSize: number = RECIPIENT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/** Why a recipient did not get a message, or what went wrong; '' when there is nothing to explain. */
export function recipientReason(r: Pick<RecipientRow, 'status' | 'skip_reason' | 'error' | 'error_code'>): string {
  if (r.skip_reason) return (SKIP_REASON_LABELS as Record<string, string>)[r.skip_reason as SkipReason] ?? r.skip_reason;
  if (r.status === 'holdout') return 'Not messaged on purpose, to measure the result';
  if (r.status === 'failed' || r.error) {
    const code = r.error_code ? ` (${r.error_code})` : '';
    return `${r.error || 'WhatsApp could not deliver it'}${code}`;
  }
  return '';
}

/** The lift verdict in words, including why there isn't one yet. */
export function liftSentence(results: CampaignResults): string {
  if (results.lift_pp === null) {
    return results.holdout_big_enough
      ? 'Not measurable yet: nothing has been delivered.'
      : `Not enough data yet. Measuring needs at least ${MIN_HOLDOUT_FOR_LIFT} held-back people; this campaign has ${results.holdout_n}.`;
  }
  return 'Compared with customers we did not message, this many more percentage points came back. Only that difference is the campaign’s doing.';
}

/** "Still counting returns until 9 Oct, 5:10 pm" / "Returns were counted until …" / "Not sent yet". */
export function attributionSentence(results: CampaignResults): string {
  if (!results.window_closes_at) return 'Not sent yet, so no returns are being counted.';
  const when = formatIstDateTime(results.window_closes_at);
  return results.attribution_open ? `Still counting returns until ${when} (IST).` : `Returns were counted until ${when} (IST).`;
}
