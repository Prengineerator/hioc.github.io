// Customer notification message templates (F4 / XC-020..023).
// Provider-agnostic plain-text bodies — a real WhatsApp/SMS adapter maps these
// onto its own approved templates. Kept tiny and dependency-free so both the
// engine and tests can render them.

import type { NotificationEvent, Order, PaymentMethod } from '@/lib/types';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import { CAFE_NAME } from '@/lib/constants';
import { absoluteUrl } from '@/lib/url';

export interface RenderedMessage {
  event: NotificationEvent;
  body: string;
}

// Absolute link to the customer's live-status page (C1). A WhatsApp/SMS message
// needs a full clickable URL, so prefer the explicit NEXT_PUBLIC_SITE_URL, then
// fall back to Vercel's runtime production domain, and only then to a bare path.
function statusLink(order: Order): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const base = (explicit || (vercel ? `https://${vercel}` : '')).replace(/\/$/, '');
  return `${base}/order/${order.id}`;
}

// The RCT-1 bill summary quotes the order's line count. A just-placed or
// resend-loaded order is shaped as an OrderResponse (carries `items`); a bare
// Order row (e.g. from a plain select('*')) won't, so fall back to 0. Kept as a
// cast so the exported render/template signatures stay `Order`.
function itemCountOf(order: Order): number {
  const items = (order as Order & { items?: unknown[] }).items;
  return Array.isArray(items) ? items.length : 0;
}

// Human label for the {{5}} payment-method var / bill body. Never empty — Meta
// rejects empty template params, and the method may still be null (unsettled web
// order whose bill sent at placement), which reads as "counter".
function paymentLabel(method: PaymentMethod | null): string {
  switch (method) {
    case 'cash':
      return 'Cash';
    case 'upi':
      return 'UPI';
    case 'card':
      return 'Card';
    case 'online':
      return 'Online';
    default:
      return 'counter';
  }
}

export function renderNotification(order: Order, event: NotificationEvent): RenderedMessage {
  const num = `#${formatOrderNumber(order.order_number)}`;
  const name = order.customer_name?.split(' ')[0] || 'there';
  const link = statusLink(order);

  switch (event) {
    case 'accepted': {
      const eta = order.promised_ready_at
        ? ` Ready by ~${formatIstTime(new Date(order.promised_ready_at))}.`
        : '';
      return {
        event,
        body: `Hi ${name}, ${CAFE_NAME} has accepted your order ${num}.${eta} Track it live: ${link}`,
      };
    }
    case 'ready': {
      const code = order.pickup_code ? ` Show pickup code ${order.pickup_code} at the counter.` : '';
      return {
        event,
        body: `Your order ${num} is ready for pickup!${code} See you soon at ${CAFE_NAME}.`,
      };
    }
    case 'rejected': {
      const reason = order.reject_reason ? ` Reason: ${order.reject_reason}.` : '';
      return {
        event,
        body: `Sorry ${name}, ${CAFE_NAME} couldn't take order ${num} right now.${reason} No charge was made.`,
      };
    }
    case 'cancelled': {
      const reason = order.reject_reason ? ` Reason: ${order.reject_reason}.` : '';
      return {
        event,
        body: `Your order ${num} at ${CAFE_NAME} has been cancelled.${reason}`,
      };
    }
    case 'bill': {
      // RCT-1: the same six facts as the order_bill_1 template — name, order #,
      // total, item count, payment method, receipt link.
      const billLink = absoluteUrl(`/order/${order.id}/receipt`);
      const total = order.total_inr ?? order.subtotal_inr;
      return {
        event,
        body: `Hi ${name}, thanks for visiting ${CAFE_NAME} Your bill for order ${num}: ₹${total} for ${itemCountOf(order)} item(s), paid via ${paymentLabel(order.payment_method)}. View your itemized receipt: ${billLink}`,
      };
    }
  }
}

// Ordered body variables for a WhatsApp/DLT approved template (Meta requires
// templates, not free text, for proactive messages). The ORDER must match the
// {{1}},{{2}},… placeholders in each registered template (see the template table
// in the setup notes). Values are never empty (Meta rejects empty params).
export function templateVarsFor(order: Order, event: NotificationEvent): string[] {
  const num = formatOrderNumber(order.order_number);
  const name = order.customer_name?.split(' ')[0] || 'there';
  const link = statusLink(order);
  switch (event) {
    case 'accepted': {
      const eta = order.promised_ready_at ? formatIstTime(new Date(order.promised_ready_at)) : 'soon';
      return [name, num, eta, link]; // order_accepted: {{1}}name {{2}}num {{3}}eta {{4}}link
    }
    case 'ready':
      return [num]; // order_ready_1: {{1}}num only (pickup code dropped to pass Utility review)
    case 'rejected':
      return [name, num, order.reject_reason || 'unavailable']; // {{1}}name {{2}}num {{3}}reason
    case 'cancelled':
      return [num, order.reject_reason || 'as requested']; // {{1}}num {{2}}reason
    case 'bill': {
      // order_bill_1 (RCT-1), 6 vars in this exact order:
      // {{1}}name {{2}}order# {{3}}total₹ {{4}}item count {{5}}payment method
      // {{6}}receipt link (/order/<id>/receipt). The template literal supplies the
      // '#' before {{2}}, so num stays the bare formatted number.
      const total = order.total_inr ?? order.subtotal_inr;
      return [
        name,
        num,
        String(total),
        String(itemCountOf(order)),
        paymentLabel(order.payment_method),
        absoluteUrl(`/order/${order.id}/receipt`),
      ];
    }
  }
}
