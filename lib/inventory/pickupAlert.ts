// The delivery person's WhatsApp list (docs/WAREHOUSE-SPEC.md, WH-D17).
//
// When a manager or the owner chooses a TEAM MEMBER to bring a warehouse
// request to the store, that person gets one WhatsApp message: their name, the
// request number and the items asked for. The number is the one the owner typed
// on Staff (staff_accounts.phone), normalised to +91XXXXXXXXXX; profiles.phone
// is the customer-account number and is never read. An outside driver
// (deliverer_name / deliverer_phone) is NOT messaged: no send, no row.
//
// Off until WHATSAPP_TPL_STOCK_PICKUP names the approved template (WH-D17g).
//
// No record, no send. The attempt is claimed first: a warehouse_alerts row
// (event 'pickup_assigned', channel 'whatsapp') is inserted as 'sent' BEFORE
// the message goes. The unique index on sent rows is the once-only check and is
// race-safe:
//   23505          already sent: do not send.
//   23514 / other  the log is not ready (supabase/2026-11-warehouse-pickup-alert.sql
//                  not applied): do not send, say "not set up".
//   provider says no   the row becomes 'failed' with the reason, which frees a retry.
//   no answer in SEND_TIMEOUT_MS   the row stays 'sent' ("not confirmed"), so a
//                  retry cannot send it twice; the chooser is told to tell them.
// At most DAILY_LIMIT messages go in any 24 hours.
//
// Never throws. The server log gets fixed text and error codes only: never a
// name, a number or a database error object.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { whatsappAdapter } from '@/lib/notifications/adapters';
import { indianE164HonouringPlus } from '@/lib/phone';
import { formatQty } from '@/lib/inventory/rules';
import type { PickupResult } from '@/lib/inventory/pickupNotice';
import { alreadySent, logAlert, waVar } from '@/lib/inventory/ownerAlerts';

export type { PickupResult };

export const PICKUP_TEMPLATE_ENV = 'WHATSAPP_TPL_STOCK_PICKUP';
export const PICKUP_TEMPLATE_LANG_ENV = 'WHATSAPP_TPL_STOCK_PICKUP_LANG';
export const PICKUP_MIGRATION_FILE = 'supabase/2026-11-warehouse-pickup-alert.sql';

/** How long choosing a delivery person waits for WhatsApp. The adapter's own fetch has no limit. */
export const SEND_TIMEOUT_MS = 8000;
/** Most pickup messages the café sends in any 24 hours. */
export const DAILY_LIMIT = 40;
/** The items variable is cut at about this many characters, on an item boundary. */
export const ITEMS_MAX = 600;
const ITEM_MAX = 120;
const NAME_MAX = 40;

export interface PickupLine {
  name: string;
  unit: string;
  qty: number;
}

/** "Milk 20 L, Cups 500 pcs and 2 more": every item on one line, cut on an item boundary. */
export function pickupItemsVar(lines: PickupLine[], max = ITEMS_MAX): string {
  const parts = lines.map((l) => waVar(`${l.name} ${formatQty(l.qty, l.unit)}`, ITEM_MAX));
  if (parts.length === 0) return '-';
  const fits = (k: number) => {
    const head = parts.slice(0, k).join(', ');
    return k < parts.length ? `${head} and ${parts.length - k} more` : head;
  };
  let k = parts.length;
  while (k > 1 && fits(k).length > max) k -= 1;
  return waVar(fits(k), max + 40);
}

/** Letters (any language), spaces, hyphens and apostrophes only; at most 40 characters; "there" if nothing usable. */
export function pickupNameVar(name: string): string {
  const v = name
    .replace(/[^\p{L}\p{M}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return v.length < 2 ? 'there' : v;
}

/** {{1}} name, {{2}} request number, {{3}} items. Never empty. */
export function pickupVars(name: string, requestNumber: number, lines: PickupLine[]): string[] {
  return [pickupNameVar(name), waVar(String(requestNumber), 20), pickupItemsVar(lines)];
}

type ReqRow = {
  request_number: number;
  stock_request_lines: { qty_requested: number; inventory_items: { name: string; unit: string } | null }[] | null;
};

const TIMED_OUT = Symbol('timed out');

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  p.catch(() => undefined); // a late rejection from the abandoned send is not unhandled
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sends the list to the team member just chosen. Returns null when switched
 * off; otherwise a fixed status for the screen (never the provider's text, which
 * stays on the Alerts tab). The caller decides the rest of "does it apply": a
 * warehouse-to-store request, a team member, not the chooser themselves.
 */
export async function sendPickupAlert(
  admin: SupabaseClient,
  args: { requestId: string; userId: string; name: string },
): Promise<PickupResult | null> {
  const template = process.env[PICKUP_TEMPLATE_ENV]?.trim();
  if (!template) return null;
  const { requestId } = args;
  const base = { event: 'pickup_assigned' as const, requestId, channel: 'whatsapp' as const, providerRef: '' };
  try {
    const [reqRes, acctRes] = await Promise.all([
      admin
        .from('stock_requests')
        .select('request_number, stock_request_lines(qty_requested, inventory_items(name, unit))')
        .eq('id', requestId)
        .maybeSingle(),
      admin.from('staff_accounts').select('phone').eq('user_id', args.userId).maybeSingle(),
    ]);
    const req = (reqRes.data as ReqRow | null) ?? null;
    if (!req) {
      console.error('pickup alert: request not found');
      return 'failed';
    }
    const to = indianE164HonouringPlus((acctRes.data as { phone?: string | null } | null)?.phone ?? '');

    if (!to) {
      await logAlert(admin, { ...base, to: '', status: 'skipped', detail: 'No WhatsApp number saved for the delivery person' });
      return 'no_number';
    }
    if (await alreadySent(admin, 'pickup_assigned', requestId, 'whatsapp', to)) return 'already_sent';

    // Daily limit: fail closed if it cannot be counted.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await admin
      .from('warehouse_alerts')
      .select('id', { count: 'exact', head: true })
      .eq('event', 'pickup_assigned')
      .eq('status', 'sent')
      .gte('created_at', since);
    if (countError || typeof count !== 'number') {
      console.error('pickup alert: could not count today’s messages', countError?.code ?? '');
      return 'failed';
    }
    if (count >= DAILY_LIMIT) {
      await logAlert(admin, { ...base, to, status: 'skipped', detail: 'daily limit' });
      return 'limit_reached';
    }

    // Claim first: no record, no send.
    const claim = await admin
      .from('warehouse_alerts')
      .insert({
        event: 'pickup_assigned',
        request_id: requestId,
        channel: 'whatsapp',
        to_address: to,
        status: 'sent',
        detail: 'sending',
        provider_ref: '',
      })
      .select('id')
      .maybeSingle();
    if (claim.error) {
      if (claim.error.code === '23505') return 'already_sent';
      console.error(
        `pickup alert: the attempt could not be recorded (code ${claim.error.code ?? 'unknown'}), so nothing was sent. ` +
          `If the code is 23514, run ${PICKUP_MIGRATION_FILE} on the live database (Hioc India).`,
      );
      return 'not_set_up';
    }
    const rowId = (claim.data as { id?: string } | null)?.id;
    const settle = async (patch: Record<string, unknown>) => {
      if (!rowId) return;
      const { error } = await admin.from('warehouse_alerts').update(patch).eq('id', rowId);
      if (error) console.error('pickup alert: could not update the log row', error.code ?? '');
    };

    const lines = (req.stock_request_lines ?? [])
      .map((l) => ({ name: l.inventory_items?.name ?? 'Item', unit: l.inventory_items?.unit ?? '', qty: Number(l.qty_requested) }))
      .sort((a, b) => a.name.localeCompare(b.name)); // the same order the email uses
    const vars = pickupVars(args.name, req.request_number, lines);

    const res = await withTimeout(
      whatsappAdapter.send({
        to,
        channel: 'whatsapp',
        body: `Hi ${vars[0]}, stock request #${vars[1]} is yours to bring from the HIOC warehouse to the store. Items asked for: ${vars[2]}.`,
        templateName: template,
        templateLang: process.env[PICKUP_TEMPLATE_LANG_ENV]?.trim() || undefined,
        templateVars: vars,
      }).catch(() => ({ ok: false, providerRef: '', error: 'send failed' })),
      SEND_TIMEOUT_MS,
    );
    if (res === TIMED_OUT) {
      await settle({ detail: `Not confirmed: no answer from WhatsApp within ${SEND_TIMEOUT_MS / 1000} seconds. It may still arrive.` });
      return 'not_confirmed';
    }
    if (res.ok) {
      await settle({ detail: '', provider_ref: res.providerRef });
      return 'sent';
    }
    await settle({ status: 'failed', detail: String(res.error).slice(0, 500) });
    return 'failed';
  } catch (err) {
    console.error('pickup alert failed', err instanceof Error ? err.name : 'error');
    return 'failed';
  }
}
