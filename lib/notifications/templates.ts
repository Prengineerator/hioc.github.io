// Customer notification message templates (F4 / XC-020..023).
// Provider-agnostic plain-text bodies — a real WhatsApp/SMS adapter maps these
// onto its own approved templates. Kept tiny and dependency-free so both the
// engine and tests can render them.

import type { NotificationEvent, Order } from '@/lib/types';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import { CAFE_NAME } from '@/lib/constants';

export interface RenderedMessage {
  event: NotificationEvent;
  body: string;
}

// Absolute link to the customer's live-status page (C1). SITE_URL is set in
// prod; falls back to a relative path the client can still resolve.
function statusLink(order: Order): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  return `${base}/order/${order.id}`;
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
      return [num, order.pickup_code || '----']; // order_ready: {{1}}num {{2}}code
    case 'rejected':
      return [name, num, order.reject_reason || 'unavailable']; // {{1}}name {{2}}num {{3}}reason
    case 'cancelled':
      return [num, order.reject_reason || 'as requested']; // {{1}}num {{2}}reason
  }
}
