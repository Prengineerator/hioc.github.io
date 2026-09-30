// The numbers the Approvals confirm dialog quotes to the owner before a campaign
// is sent. They are money and message counts, so they live here, pure and
// unit-tested (tests/marketingDashboardFormat.test.ts), instead of inline in JSX.

import type { CampaignSummary } from '@/lib/marketing/types';

/**
 * How many messages approving this campaign can send: the treated audience.
 * `treated_count` is what the planner stored; a draft made a moment ago may
 * still carry 0 there, so the projection's own count is the fallback.
 */
export function approvalMessageCount(c: Pick<CampaignSummary, 'treated_count' | 'projection'>): number {
  return c.treated_count > 0 ? c.treated_count : Math.max(0, c.projection.treated);
}

/** The most the WhatsApp fees can be: every message sent and charged. ₹, to 2 decimals. */
export function maxMessageCost(c: Pick<CampaignSummary, 'treated_count' | 'projection'>): number {
  return Math.round(approvalMessageCount(c) * c.projection.message_cost_inr * 100) / 100;
}

/** "1 message" / "162 messages". */
export function pluralize(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}
