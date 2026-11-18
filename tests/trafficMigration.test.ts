import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_GROUPS, TRACKED_ROUTES, TRAFFIC_DEVICES, TRAFFIC_EVENTS, TRAFFIC_SOURCES } from '@/lib/traffic/types';
import { buildCampaignLink } from '@/components/owner/traffic/CampaignLinkBuilder';

// supabase/2026-11-traffic-tracking.sql pins the vocabularies of
// lib/traffic/types.ts in CHECK constraints. If one side changes without the
// other, inserts start failing silently (they are best-effort), so pin them.

const sql = readFileSync(path.resolve(__dirname, '../supabase/2026-11-traffic-tracking.sql'), 'utf8');

function checkList(constraint: string): string[] {
  const at = sql.indexOf(`add constraint ${constraint}`);
  expect(at, `${constraint} is in the migration`).toBeGreaterThan(-1);
  const body = sql.slice(at, sql.indexOf(';', at));
  // [^)] already spans line breaks, so no dotAll flag is needed.
  const inList = /in \(([^)]*)\)/.exec(body);
  expect(inList, `${constraint} has an IN list`).not.toBeNull();
  return [...inList![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('traffic migration ↔ lib/traffic/types.ts', () => {
  it('events', () => expect(checkList('traffic_events_event_check')).toEqual([...TRAFFIC_EVENTS]));
  it('page groups', () => expect(checkList('traffic_events_page_group_check')).toEqual([...PAGE_GROUPS]));
  it('sources', () => expect(checkList('traffic_events_source_check')).toEqual([...TRAFFIC_SOURCES]));
  it('devices', () => expect(checkList('traffic_events_device_check')).toEqual([...TRAFFIC_DEVICES]));

  it('every route fits the route length check', () => {
    for (const route of Object.keys(TRACKED_ROUTES)) expect(route.length).toBeLessThanOrEqual(64);
  });

  it('keeps RLS on with no policy, and stores no IP or User-Agent column', () => {
    expect(sql).toMatch(/alter table traffic_events enable row level security;/);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/\b(ip|ip_address|user_agent)\b\s+(text|inet)/i);
  });
});

describe('buildCampaignLink (Owner → Traffic link maker)', () => {
  it('tags a page with clean, lower-case values', () => {
    expect(buildCampaignLink('https://hioc.in', '/shop', { source: 'instagram', medium: 'Bio', campaign: 'Diwali Offer' })).toBe(
      'https://hioc.in/shop?utm_source=instagram&utm_medium=bio&utm_campaign=diwali-offer',
    );
  });

  it('tags the Ask Coffey wizard', () => {
    expect(buildCampaignLink('https://hioc.in', '/suggest', { source: 'instagram', medium: 'story', campaign: 'Ask Coffey' })).toBe(
      'https://hioc.in/suggest?utm_source=instagram&utm_medium=story&utm_campaign=ask-coffey',
    );
  });

  it('tags the About Coffey page', () => {
    expect(buildCampaignLink('https://hioc.in', '/coffey', { source: 'whatsapp', medium: 'status', campaign: '' })).toBe(
      'https://hioc.in/coffey?utm_source=whatsapp&utm_medium=status',
    );
  });

  it('leaves out empty tags', () => {
    expect(buildCampaignLink('https://hioc.in', '/menu', { source: 'qr', medium: '', campaign: '  ' })).toBe(
      'https://hioc.in/menu?utm_source=qr',
    );
  });
});
