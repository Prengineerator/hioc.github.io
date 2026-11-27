// Owner alerts for the warehouse (docs/WAREHOUSE-SPEC.md, WH-D9..D11):
//
//   request_placed     the store asked the warehouse for stock
//   return_sent        the store sent stock back to the warehouse
//   arrived_different  a delivery was counted in different from what was sent
//
// Email always (every owner account's login email unless switched off, plus
// any extra addresses), through the same Resend account as the reports.
// WhatsApp to the numbers the owner lists, once a Utility template is
// approved and named in WHATSAPP_TPL_STOCK_ALERT (a business-initiated
// WhatsApp message must be a Meta-approved template); until then each
// WhatsApp attempt is logged as skipped with the reason. The owner's header
// badge (Warehouse) covers the owner whenever the portal is open.
//
// Every attempt is a row in warehouse_alerts, and an address that already got
// this alert for this request is not sent it again (a retried request, a
// re-run). Nothing here throws: placing a request must never fail because an
// alert did — callers run it after the response (lib/api/background.ts).

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emailAdapter, whatsappAdapter } from '@/lib/notifications/adapters';
import { escapeHtml, staffEmailShell } from '@/lib/staff/emails';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import { ownerLoginEmails } from '@/lib/reports/ownerDigestServer';
import { absoluteUrl } from '@/lib/url';
import { flags } from '@/lib/flags';
import { formatQty, roundQty, type StockRoute } from '@/lib/inventory/rules';
import { indianE164HonouringPlus } from '@/lib/phone';

export type OwnerAlertEvent = 'request_placed' | 'return_sent' | 'arrived_different';
export type AlertChannel = 'email' | 'whatsapp';
export type AlertStatus = 'sent' | 'failed' | 'skipped';

export const WAREHOUSE_PATH = '/owner/warehouse';
export const STOCK_ALERT_TEMPLATE_ENV = 'WHATSAPP_TPL_STOCK_ALERT';

// ── Settings ────────────────────────────────────────────────────────────────

export interface AlertSettings {
  enabled: boolean;
  /** Also email every owner account's login email. */
  emailOwnerLogins: boolean;
  /** Extra addresses (a partner, the warehouse keeper). */
  emails: string[];
  /** WhatsApp numbers, +91XXXXXXXXXX. */
  whatsappPhones: string[];
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: true,
  emailOwnerLogins: true,
  emails: [],
  whatsappPhones: [],
};

export const MAX_ALERT_EMAILS = 10;
export const MAX_ALERT_PHONES = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The owner's edits to the alert settings. Every field optional; lists are replaced whole. */
export function parseAlertSettingsPatch(
  body: Record<string, unknown>,
): { ok: true; patch: Partial<AlertSettings> } | { ok: false; message: string } {
  const patch: Partial<AlertSettings> = {};
  for (const key of ['enabled', 'emailOwnerLogins'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return { ok: false, message: `${key} must be true or false` };
    patch[key] = body[key] as boolean;
  }
  if (body.emails !== undefined) {
    if (!Array.isArray(body.emails)) return { ok: false, message: 'emails must be a list' };
    const emails = [...new Set(body.emails.map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : '')).filter(Boolean))];
    const bad = emails.find((e) => !EMAIL_RE.test(e) || e.length > 200);
    if (bad) return { ok: false, message: `“${bad}” is not an email address.` };
    if (emails.length > MAX_ALERT_EMAILS) return { ok: false, message: `At most ${MAX_ALERT_EMAILS} email addresses.` };
    patch.emails = emails;
  }
  if (body.whatsappPhones !== undefined) {
    if (!Array.isArray(body.whatsappPhones)) return { ok: false, message: 'whatsappPhones must be a list' };
    const phones: string[] = [];
    for (const raw of body.whatsappPhones) {
      if (typeof raw === 'string' && raw.trim() === '') continue;
      const p = indianE164HonouringPlus(raw);
      if (!p) return { ok: false, message: `“${String(raw)}” is not a valid Indian mobile number.` };
      if (!phones.includes(p)) phones.push(p);
    }
    if (phones.length > MAX_ALERT_PHONES) return { ok: false, message: `At most ${MAX_ALERT_PHONES} WhatsApp numbers.` };
    patch.whatsappPhones = phones;
  }
  return { ok: true, patch };
}

type SettingsRow = {
  enabled: boolean;
  email_owner_logins: boolean;
  emails: string[] | null;
  whatsapp_phones: string[] | null;
};

function readSettings(row: SettingsRow | null): AlertSettings {
  if (!row) return { ...DEFAULT_ALERT_SETTINGS };
  return {
    enabled: row.enabled !== false,
    emailOwnerLogins: row.email_owner_logins !== false,
    emails: row.emails ?? [],
    whatsappPhones: row.whatsapp_phones ?? [],
  };
}

/** The settings, or the defaults when the row (or the migration) is missing. */
export async function loadAlertSettings(admin: SupabaseClient): Promise<{ settings: AlertSettings; migrated: boolean }> {
  const { data, error } = await admin
    .from('warehouse_alert_settings')
    .select('enabled, email_owner_logins, emails, whatsapp_phones')
    .eq('is_singleton', true)
    .maybeSingle();
  if (error) return { settings: { ...DEFAULT_ALERT_SETTINGS }, migrated: false };
  return { settings: readSettings(data as SettingsRow | null), migrated: true };
}

export async function saveAlertSettings(
  admin: SupabaseClient,
  patch: Partial<AlertSettings>,
  actorId: string,
): Promise<{ settings: AlertSettings } | { error: { code?: string; message?: string } }> {
  const row: Record<string, unknown> = { is_singleton: true, updated_by: actorId, updated_at: new Date().toISOString() };
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.emailOwnerLogins !== undefined) row.email_owner_logins = patch.emailOwnerLogins;
  if (patch.emails !== undefined) row.emails = patch.emails;
  if (patch.whatsappPhones !== undefined) row.whatsapp_phones = patch.whatsappPhones;
  const { data, error } = await admin
    .from('warehouse_alert_settings')
    .upsert(row, { onConflict: 'is_singleton' })
    .select('enabled, email_owner_logins, emails, whatsapp_phones')
    .maybeSingle();
  if (error) return { error };
  return { settings: readSettings(data as SettingsRow | null) };
}

/** Where alerts go, given the settings and the owner accounts' login emails. */
export function alertRecipients(settings: AlertSettings, ownerEmails: string[]): { emails: string[]; phones: string[] } {
  if (!settings.enabled) return { emails: [], phones: [] };
  const emails = [
    ...(settings.emailOwnerLogins ? ownerEmails.map((e) => e.trim().toLowerCase()) : []),
    ...settings.emails.map((e) => e.trim().toLowerCase()),
  ].filter(Boolean);
  return { emails: [...new Set(emails)], phones: [...new Set(settings.whatsappPhones)] };
}

/** What is configured for each channel — shown on the Alerts tab. */
export function alertChannelHealth(): { email: { ready: boolean; missing: string[] }; whatsapp: { ready: boolean; missing: string[] } } {
  const emailMissing = [
    ...(process.env.RESEND_API_KEY ? [] : ['RESEND_API_KEY']),
    ...(process.env.RESEND_FROM_REPORTS || process.env.RESEND_FROM ? [] : ['RESEND_FROM']),
  ];
  const waMissing = [
    ...(process.env.WHATSAPP_TOKEN ? [] : ['WHATSAPP_TOKEN']),
    ...(process.env.WHATSAPP_PHONE_ID ? [] : ['WHATSAPP_PHONE_ID']),
    ...(process.env[STOCK_ALERT_TEMPLATE_ENV] ? [] : [STOCK_ALERT_TEMPLATE_ENV]),
  ];
  return { email: { ready: emailMissing.length === 0, missing: emailMissing }, whatsapp: { ready: waMissing.length === 0, missing: waMissing } };
}

// ── The message ─────────────────────────────────────────────────────────────

export interface AlertLine {
  name: string;
  unit: string;
  /** Requested (request_placed), sent (return_sent), sent (arrived_different). */
  qty: number;
  /** request_placed: what the warehouse holds now. */
  warehouseOnHand?: number | null;
  /** request_placed: what the store holds now. */
  storeOnHand?: number | null;
  /** arrived_different: what was counted in. */
  arrived?: number | null;
}

export interface AlertInput {
  event: OwnerAlertEvent;
  number: number;
  route: StockRoute;
  /** Who raised it / sent it / counted it in. */
  by: string;
  /** Whoever carries it ('' = nobody chosen yet). */
  deliveredBy: string;
  note: string;
  lines: AlertLine[];
}

/** {{1}} of the WhatsApp template, per event. */
export const ALERT_HEADLINES: Record<OwnerAlertEvent, string> = {
  request_placed: 'New stock request',
  return_sent: 'Stock sent back to the warehouse',
  arrived_different: 'Delivery counted in different from what was sent',
};

/** "Milk 10 L, Cups 500 pcs and 2 more" — short enough for a WhatsApp variable. */
export function summarizeLines(lines: AlertLine[], max = 3): string {
  const shown = lines.slice(0, max).map((l) => `${l.name} ${formatQty(l.qty, l.unit)}`);
  const more = lines.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/** Meta refuses template parameters with newlines, tabs or 4+ spaces in a row. */
function waVar(s: string, max = 300): string {
  const v = s.replace(/\s+/g, ' ').trim();
  return (v.length > max ? `${v.slice(0, max - 1)}…` : v) || '-';
}

/** Subject, HTML, text and the WhatsApp template's variables. Pure, so it is tested directly. */
export function renderOwnerAlert(input: AlertInput): { subject: string; html: string; text: string; whatsappVars: string[] } {
  const link = absoluteUrl(WAREHOUSE_PATH);
  const n = `#${input.number}`;
  const count = `${input.lines.length} item${input.lines.length === 1 ? '' : 's'}`;
  let subject: string;
  let lead: string;
  let action: string;
  if (input.event === 'request_placed') {
    subject = `New stock request ${n} from ${input.by} — ${count}`;
    lead = `${input.by} asked the warehouse for:`;
    action = 'Choose who delivers it and record what you send on the Warehouse page.';
  } else if (input.event === 'return_sent') {
    subject = `Stock on its way back to the warehouse — ${n}, ${count}`;
    lead = `${input.by} sent this back to the warehouse${input.deliveredBy ? `, carried by ${input.deliveredBy}` : ''}:`;
    action = 'Count it in when it arrives (Warehouse → Requests).';
  } else {
    subject = `Stock ${n} arrived different from what was sent`;
    lead = `${input.by} counted ${n} in${input.deliveredBy ? ` (delivered by ${input.deliveredBy})` : ''}, and some lines don’t match:`;
    action = 'Settle each line on the Warehouse page: lost on the way, never left, or sent more than recorded.';
  }

  const rows = input.lines.map((l) => {
    if (input.event === 'request_placed') {
      const wh = l.warehouseOnHand === undefined || l.warehouseOnHand === null ? '—' : formatQty(l.warehouseOnHand, l.unit);
      const st = l.storeOnHand === undefined || l.storeOnHand === null ? '—' : formatQty(l.storeOnHand, l.unit);
      const short = l.warehouseOnHand !== undefined && l.warehouseOnHand !== null && roundQty(l.warehouseOnHand) < roundQty(l.qty);
      return {
        cells: [l.name, formatQty(l.qty, l.unit), wh, st],
        text: `- ${l.name} — ${formatQty(l.qty, l.unit)} (warehouse has ${wh}, store has ${st})${short ? ' — warehouse is short' : ''}`,
        warn: short,
      };
    }
    if (input.event === 'arrived_different') {
      const arrived = l.arrived === undefined || l.arrived === null ? '—' : formatQty(l.arrived, l.unit);
      return {
        cells: [l.name, formatQty(l.qty, l.unit), arrived],
        text: `- ${l.name} — sent ${formatQty(l.qty, l.unit)}, arrived ${arrived}`,
        warn: true,
      };
    }
    return { cells: [l.name, formatQty(l.qty, l.unit)], text: `- ${l.name} — ${formatQty(l.qty, l.unit)}`, warn: false };
  });
  const head =
    input.event === 'request_placed'
      ? ['Item', 'Asked', 'Warehouse has', 'Store has']
      : input.event === 'arrived_different'
        ? ['Item', 'Sent', 'Arrived']
        : ['Item', 'Sent'];
  const th = (t: string, i: number) =>
    `<th style="text-align:${i === 0 ? 'left' : 'right'};font-size:12px;color:#6b6b6b;padding:4px 6px;border-bottom:1px solid #e5e5e5;">${escapeHtml(t)}</th>`;
  const td = (t: string, i: number, warn: boolean) =>
    `<td style="text-align:${i === 0 ? 'left' : 'right'};font-size:14px;padding:6px;border-bottom:1px solid #f0f0f0;${warn && i > 0 ? 'color:#b42318;font-weight:bold;' : ''}">${escapeHtml(t)}</td>`;
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 12px;">
      <tr>${head.map(th).join('')}</tr>
      ${rows.map((r) => `<tr>${r.cells.map((c, i) => td(c, i, r.warn)).join('')}</tr>`).join('')}
    </table>`;

  const html = staffEmailShell(
    subject,
    `<p style="font-size:14px;line-height:1.5;">${escapeHtml(lead)}</p>
     ${table}
     ${input.note ? `<p style="font-size:14px;line-height:1.5;">Note: “${escapeHtml(input.note)}”</p>` : ''}
     <p style="font-size:14px;line-height:1.5;">${escapeHtml(action)}</p>
     <p style="text-align:center;margin:24px 0;"><a href="${link}" style="display:inline-block;background:#b08968;color:#fffdfa;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:6px;font-size:14px;">Open Warehouse</a></p>`,
  );
  const text = [lead, ...rows.map((r) => r.text), ...(input.note ? [`Note: "${input.note}"`] : []), '', action, link].join('\n');

  // The approved template (docs/WAREHOUSE-SPEC.md §F, WhatsApp):
  //   "HIOC stock update — {{1}} #{{2}}, by {{3}}: {{4}}. Please open the
  //    owner portal to act on it."
  const whatsappVars = [
    waVar(ALERT_HEADLINES[input.event]),
    String(input.number),
    waVar(input.by, 60),
    waVar(input.event === 'request_placed' ? summarizeLines(input.lines) : `${count}: ${summarizeLines(input.lines)}`),
  ];
  return { subject, html, text, whatsappVars };
}

// ── Sending ─────────────────────────────────────────────────────────────────

export interface AlertOutcome {
  channel: AlertChannel;
  to: string;
  status: AlertStatus | 'already_sent';
  detail: string;
}

type RequestRow = {
  request_number: number;
  route: StockRoute;
  note: string | null;
  requested_by: string;
  received_by: string | null;
  assigned_to: string | null;
  deliverer_name: string | null;
  stock_request_lines: {
    item_id: string;
    qty_requested: number;
    qty_picked: number | null;
    qty_received: number | null;
    inventory_items: { name: string; unit: string } | null;
  }[] | null;
};

async function onHandByItem(admin: SupabaseClient, table: 'warehouse_batches' | 'inventory_batches', ids: string[]): Promise<Map<string, number> | null> {
  if (ids.length === 0) return new Map();
  const { data, error } = await admin.from(table).select('item_id, qty_remaining').in('item_id', ids).gt('qty_remaining', 0);
  if (error) return null;
  const map = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const b of (data ?? []) as { item_id: string; qty_remaining: number }[]) {
    map.set(b.item_id, roundQty((map.get(b.item_id) ?? 0) + Number(b.qty_remaining)));
  }
  return map;
}

/** Builds the alert for one request from the database. Null when the request is gone. */
async function buildAlert(admin: SupabaseClient, event: OwnerAlertEvent, requestId: string): Promise<AlertInput | null> {
  const { data, error } = await admin
    .from('stock_requests')
    .select(
      'request_number, route, note, requested_by, received_by, assigned_to, deliverer_name, stock_request_lines(item_id, qty_requested, qty_picked, qty_received, inventory_items(name, unit))',
    )
    .eq('id', requestId)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as unknown as RequestRow;
  const people = [r.requested_by, r.received_by, r.assigned_to].filter((v): v is string => Boolean(v));
  const names = await getStaffDisplayNames(admin, [...new Set(people)]);
  const name = (id: string | null) => (id ? names.get(id) ?? 'A staffer' : '');

  const rawLines = (r.stock_request_lines ?? [])
    .slice()
    .sort((a, b) => (a.inventory_items?.name ?? '').localeCompare(b.inventory_items?.name ?? ''));
  const ids = rawLines.map((l) => l.item_id);
  const [warehouse, store] =
    event === 'request_placed'
      ? await Promise.all([onHandByItem(admin, 'warehouse_batches', ids), onHandByItem(admin, 'inventory_batches', ids)])
      : [null, null];

  const lines: AlertLine[] = rawLines
    .filter((l) => event !== 'arrived_different' || roundQty(Number(l.qty_picked) || 0) !== roundQty(Number(l.qty_received) || 0))
    .map((l) => ({
      name: l.inventory_items?.name ?? 'Item',
      unit: l.inventory_items?.unit ?? '',
      qty: Number(event === 'request_placed' ? l.qty_requested : l.qty_picked ?? l.qty_requested),
      warehouseOnHand: warehouse ? warehouse.get(l.item_id) ?? 0 : undefined,
      storeOnHand: store ? store.get(l.item_id) ?? 0 : undefined,
      arrived: event === 'arrived_different' ? Number(l.qty_received ?? 0) : undefined,
    }));

  return {
    event,
    number: r.request_number,
    route: r.route,
    by: event === 'arrived_different' ? name(r.received_by) || 'The store' : name(r.requested_by) || 'The store',
    deliveredBy: r.assigned_to ? name(r.assigned_to) : (r.deliverer_name ?? '').trim(),
    note: r.note ?? '',
    lines,
  };
}

async function alreadySent(admin: SupabaseClient, event: OwnerAlertEvent, requestId: string, channel: AlertChannel, to: string) {
  const { data } = await admin
    .from('warehouse_alerts')
    .select('id')
    .eq('event', event)
    .eq('request_id', requestId)
    .eq('channel', channel)
    .eq('to_address', to)
    .eq('status', 'sent')
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

async function logAlert(
  admin: SupabaseClient,
  row: { event: OwnerAlertEvent; requestId: string; channel: AlertChannel; to: string; status: AlertStatus; detail: string; providerRef: string },
) {
  const { error } = await admin.from('warehouse_alerts').insert({
    event: row.event,
    request_id: row.requestId,
    channel: row.channel,
    to_address: row.to,
    status: row.status,
    detail: row.detail.slice(0, 500),
    provider_ref: row.providerRef,
  });
  if (error) console.error('warehouse_alerts log insert failed', row.event, error);
}

/**
 * Tell the owner. Never throws; returns what happened per address. A no-op
 * with the warehouse switched off, or with alerts switched off on the Alerts tab.
 */
export async function sendOwnerAlert(admin: SupabaseClient, event: OwnerAlertEvent, requestId: string): Promise<AlertOutcome[]> {
  if (!flags.inventory || !flags.warehouse) return [];
  try {
    const [{ settings }, input] = await Promise.all([loadAlertSettings(admin), buildAlert(admin, event, requestId)]);
    if (!settings.enabled || !input || input.lines.length === 0) return [];
    const ownerEmails = settings.emailOwnerLogins ? await ownerLoginEmails(admin) : [];
    const { emails, phones } = alertRecipients(settings, ownerEmails);
    const content = renderOwnerAlert(input);
    const outcomes: AlertOutcome[] = [];

    for (const to of emails) {
      if (await alreadySent(admin, event, requestId, 'email', to)) {
        outcomes.push({ channel: 'email', to, status: 'already_sent', detail: '' });
        continue;
      }
      const res = await emailAdapter.send({
        to,
        channel: 'email',
        subject: content.subject,
        html: content.html,
        body: content.text,
        from: process.env.RESEND_FROM_REPORTS || undefined,
      });
      const status: AlertStatus = res.ok ? 'sent' : 'failed';
      await logAlert(admin, { event, requestId, channel: 'email', to, status, detail: res.error, providerRef: res.providerRef });
      outcomes.push({ channel: 'email', to, status, detail: res.error });
    }

    const template = process.env[STOCK_ALERT_TEMPLATE_ENV];
    for (const to of phones) {
      if (!template) {
        const detail = `not_configured:${STOCK_ALERT_TEMPLATE_ENV}`;
        await logAlert(admin, { event, requestId, channel: 'whatsapp', to, status: 'skipped', detail, providerRef: '' });
        outcomes.push({ channel: 'whatsapp', to, status: 'skipped', detail });
        continue;
      }
      if (await alreadySent(admin, event, requestId, 'whatsapp', to)) {
        outcomes.push({ channel: 'whatsapp', to, status: 'already_sent', detail: '' });
        continue;
      }
      const res = await whatsappAdapter.send({
        to,
        channel: 'whatsapp',
        body: content.text,
        templateName: template,
        templateLang: process.env.WHATSAPP_TPL_STOCK_ALERT_LANG || undefined,
        templateVars: content.whatsappVars,
      });
      const status: AlertStatus = res.ok ? 'sent' : 'failed';
      await logAlert(admin, { event, requestId, channel: 'whatsapp', to, status, detail: res.error, providerRef: res.providerRef });
      outcomes.push({ channel: 'whatsapp', to, status, detail: res.error });
    }

    if (emails.length === 0 && phones.length === 0) {
      console.warn(`sendOwnerAlert: nobody to tell about ${event} #${input.number} — no owner email and no extra recipients`);
    }
    return outcomes;
  } catch (err) {
    console.error('sendOwnerAlert failed', event, requestId, err);
    return [];
  }
}

export interface AlertLogRow {
  id: string;
  event: OwnerAlertEvent;
  requestNumber: number | null;
  channel: AlertChannel;
  to: string;
  status: AlertStatus;
  detail: string;
  createdAt: string;
}

/** The latest alert attempts, newest first, for the Alerts tab. */
export async function recentAlerts(admin: SupabaseClient, limit = 30): Promise<AlertLogRow[]> {
  const { data, error } = await admin
    .from('warehouse_alerts')
    .select('id, event, channel, to_address, status, detail, created_at, stock_requests(request_number)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  type Row = {
    id: string;
    event: OwnerAlertEvent;
    channel: AlertChannel;
    to_address: string;
    status: AlertStatus;
    detail: string;
    created_at: string;
    stock_requests: { request_number: number } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    event: r.event,
    requestNumber: r.stock_requests?.request_number ?? null,
    channel: r.channel,
    to: r.to_address,
    status: r.status,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}
