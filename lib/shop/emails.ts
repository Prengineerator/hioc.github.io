// Emails for the Instant Coffee shop, through the same Resend account as the
// bills (RESEND_API_KEY / RESEND_FROM). All best-effort: nothing here throws,
// and an order never fails because an email did. Without Resend configured the
// sends are skipped and the owner still sees every order on /owner/shop.
//
//   paid       → the owner ("New online order — ship it") and the customer
//                (order confirmation with a link to their order page)
//   shipped    → the customer, with the courier and tracking link
//   cancelled  → the customer, with the refund
//
// Owner recipients: every owner account's login email, plus any addresses in
// SHOP_ALERT_EMAILS (comma-separated, e.g. whoever packs the parcels).

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { emailAdapter } from '@/lib/notifications/adapters';
import { ownerLoginEmails } from '@/lib/reports/ownerDigestServer';
import { escapeHtml, staffEmailShell } from '@/lib/staff/emails';
import { normalizeEmail } from '@/lib/email';
import { absoluteUrl } from '@/lib/url';
import { googleMapsLink, locationFromRow } from './location';
import { jarsLabel, rupees } from './pricing';
import { shopOrderRef, trackingUrl } from './status';
import type { ShopOrderRow } from './types';

export const OWNER_SHOP_PATH = '/owner/shop';

export function shopOrderPath(id: string): string {
  return `/shop/order/${id}`;
}

function button(href: string, label: string): string {
  return `<p style="text-align:center;margin:24px 0;"><a href="${href}" style="display:inline-block;background:#8a6446;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:6px;font-size:14px;">${escapeHtml(label)}</a></p>`;
}

function linesTable(order: ShopOrderRow): string {
  const row = (l: string, r: string, bold = false) =>
    `<tr><td style="padding:4px 0;${bold ? 'font-weight:bold;' : ''}">${l}</td><td style="padding:4px 0;text-align:right;${bold ? 'font-weight:bold;' : ''}">${r}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px;">
    ${order.lines.map((l) => row(`${escapeHtml(l.name)} × ${l.quantity}`, rupees(l.line_total_inr))).join('')}
    ${order.discount_inr > 0 ? row(escapeHtml(order.offer_name ?? 'Offer'), `−${rupees(order.discount_inr)}`) : ''}
    ${row('Shipping', order.shipping_inr === 0 ? 'Free' : rupees(order.shipping_inr))}
    ${row('Total paid', rupees(order.total_inr), true)}
  </table>`;
}

function addressBlock(order: ShopOrderRow): string {
  return [
    order.customer_name,
    order.address_line1,
    order.address_line2,
    `${order.city}, ${order.state} ${order.pincode}`,
    order.phone,
  ]
    .filter(Boolean)
    .map(escapeHtml)
    .join('<br>');
}

function pinLine(order: ShopOrderRow): string {
  const pin = locationFromRow(order);
  return pin
    ? `<p style="font-size:14px;line-height:1.5;"><a href="${googleMapsLink(pin)}" style="color:#8a6446;font-weight:bold;">Delivery pin on Google Maps</a></p>`
    : '';
}

async function send(to: string, subject: string, title: string, body: string): Promise<void> {
  const result = await emailAdapter.send({ to, channel: 'email', subject, html: staffEmailShell(title, body), body: title });
  if (!result.ok) console.error(`shop email "${subject}" to ${to.replace(/^(.{2}).*@/, '$1…@')} not sent: ${result.error}`);
}

/** Owner login emails plus SHOP_ALERT_EMAILS, de-duplicated. */
async function ownerRecipients(): Promise<string[]> {
  const extra = (process.env.SHOP_ALERT_EMAILS ?? '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter((e): e is string => Boolean(e));
  let logins: string[] = [];
  try {
    logins = await ownerLoginEmails(createAdminSupabaseClient());
  } catch (err) {
    console.error('shop emails: could not read owner emails', err);
  }
  return [...new Set([...logins.map((e) => e.toLowerCase()), ...extra])];
}

export async function sendShopPaidEmails(order: ShopOrderRow): Promise<void> {
  const ref = shopOrderRef(order.order_number);
  try {
    const owners = await ownerRecipients();
    const ownerBody = `
      <p style="font-size:14px;line-height:1.5;">${jarsLabel(order.jar_count)} of Instant Coffee, paid online. Ship it from the Shop orders page.</p>
      ${linesTable(order)}
      <p style="font-size:14px;line-height:1.5;"><strong>Deliver to</strong><br>${addressBlock(order)}</p>
      ${pinLine(order)}
      ${button(absoluteUrl(OWNER_SHOP_PATH), 'Open Shop orders')}`;
    await Promise.all(owners.map((to) => send(to, `New online order ${ref} — ${rupees(order.total_inr)}`, `New online order ${ref}`, ownerBody)));

    const customerBody = `
      <p style="font-size:14px;line-height:1.5;">Hi ${escapeHtml(order.customer_name.split(' ')[0])}, thank you! We've got your order and will pack it soon. We'll email you the tracking link once it ships.</p>
      ${linesTable(order)}
      <p style="font-size:14px;line-height:1.5;"><strong>Delivering to</strong><br>${addressBlock(order)}</p>
      ${button(absoluteUrl(shopOrderPath(order.id)), 'View your order')}`;
    await send(order.email, `Your HIOC. order ${ref} is confirmed`, `Order ${ref} confirmed`, customerBody);
  } catch (err) {
    console.error('sendShopPaidEmails failed', err);
  }
}

export async function sendShopShippedEmail(order: ShopOrderRow): Promise<void> {
  const ref = shopOrderRef(order.order_number);
  try {
    const url = trackingUrl(order.awb_code);
    const courier = order.courier_name ? ` with ${escapeHtml(order.courier_name)}` : '';
    const body = `
      <p style="font-size:14px;line-height:1.5;">Good news — your Instant Coffee is on its way${courier}.</p>
      ${order.awb_code ? `<p style="font-size:14px;line-height:1.5;">Tracking number (AWB): <strong>${escapeHtml(order.awb_code)}</strong></p>` : ''}
      ${url ? button(url, 'Track your parcel') : button(absoluteUrl(shopOrderPath(order.id)), 'View your order')}`;
    await send(order.email, `Your HIOC. order ${ref} has shipped`, `Order ${ref} has shipped`, body);
  } catch (err) {
    console.error('sendShopShippedEmail failed', err);
  }
}

export async function sendShopCancelledEmail(order: ShopOrderRow): Promise<void> {
  const ref = shopOrderRef(order.order_number);
  try {
    const refund = order.refunded_inr
      ? `<p style="font-size:14px;line-height:1.5;">We've refunded <strong>${rupees(order.refunded_inr)}</strong> to the way you paid. Banks usually take 5–7 working days to show it.</p>`
      : '';
    const body = `
      <p style="font-size:14px;line-height:1.5;">Your order ${ref} has been cancelled.</p>
      ${refund}
      <p style="font-size:14px;line-height:1.5;">Questions? Just reply to this email or call us.</p>`;
    await send(order.email, `Your HIOC. order ${ref} was cancelled`, `Order ${ref} cancelled`, body);
  } catch (err) {
    console.error('sendShopCancelledEmail failed', err);
  }
}
