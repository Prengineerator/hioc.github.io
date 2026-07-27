// Rich HTML for the e-bill email (RCT-2). Kept separate from templates.ts (which
// holds the provider-agnostic plain-text bodies) because this is email-specific
// markup. The email carries a button linking to the hosted, printable bill at
// /order/[id]/receipt — the customer opens it to view/print/save-as-PDF.

import type { Order } from '@/lib/types';
import { absoluteUrl } from '@/lib/url';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { CAFE_NAME, CAFE_ADDRESS, CAFE_PHONE_DISPLAY } from '@/lib/constants';

export function renderBillEmail(order: Order): { subject: string; html: string } {
  const orderNo = formatOrderNumber(order.order_number);
  const total = order.total_inr ?? order.subtotal_inr;
  const billUrl = absoluteUrl(`/order/${order.id}/receipt`);
  const firstName = order.customer_name.split(' ')[0] || 'there';
  const subject = `Your ${CAFE_NAME} bill — ${orderNo}`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#faf7f4;font-family:Arial,Helvetica,sans-serif;color:#232325;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#fffdfa;border:1px solid #e5e5e5;border-radius:8px;">
      <tr><td style="padding:28px 28px 8px;text-align:center;">
        <img src="${absoluteUrl('/images/logo-black.png')}" alt="${CAFE_NAME}" width="140" style="display:inline-block;width:140px;max-width:60%;height:auto;border:0;" />
      </td></tr>
      <tr><td style="padding:8px 28px;">
        <p style="font-size:14px;line-height:1.5;">Hi ${escapeHtml(firstName)}, thanks for your order! Your bill for <strong>${orderNo}</strong> is ready.</p>
        <p style="font-size:14px;line-height:1.5;">Order total: <strong>₹${total}</strong></p>
        <p style="text-align:center;margin:24px 0;">
          <a href="${billUrl}" style="display:inline-block;background:#b08968;color:#fffdfa;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:6px;font-size:14px;">View &amp; download your bill</a>
        </p>
        <p style="font-size:12px;color:#8a8a8a;line-height:1.5;">You can open the link above any time to see your order status and print or save the bill as a PDF.</p>
      </td></tr>
      <tr><td style="padding:8px 28px 28px;border-top:1px solid #eee;text-align:center;">
        <p style="font-size:11px;color:#8a8a8a;line-height:1.5;margin:12px 0 0;">${escapeHtml(CAFE_ADDRESS)}<br/>${escapeHtml(CAFE_PHONE_DISPLAY)}</p>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, html };
}

// Minimal HTML-escape for the few user-controlled values interpolated above.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
