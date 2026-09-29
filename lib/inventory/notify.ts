// "You've been asked to pick stock request #N" — emailed to the picker when a
// manager assigns (or re-assigns) a request to them (docs/INVENTORY-SPEC.md,
// INV-9). Goes to staff_accounts.personal_email through the same logged,
// never-throwing path as every other staff email (lib/staff/emails.ts): an
// assignment must never fail because an email did. WhatsApp is not used —
// a business-initiated WhatsApp message needs a Meta-approved template, and
// the Requests tab badge already covers the person on shift.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { escapeHtml, sendStaffEmail, staffEmailShell } from '@/lib/staff/emails';
import { absoluteUrl } from '@/lib/url';
import { formatQty } from '@/lib/inventory/rules';
import type { EmailOutcome } from '@/lib/staff/accounts';

export interface AssignedEmailInput {
  requestId: string;
  requestNumber: number;
  note: string;
  assignedByName: string;
  lines: { name: string; qty: number; unit: string }[];
}

/** Subject, HTML and text for the email. Pure, so it is tested directly. */
export function renderStockAssignedEmail(input: AssignedEmailInput): { subject: string; html: string; text: string } {
  const link = absoluteUrl('/staff/inventory');
  const subject = `Stock request #${input.requestNumber} is yours to pick`;
  const items = input.lines.map((l) => `${l.name} — ${formatQty(l.qty, l.unit)}`);
  const html = staffEmailShell(
    subject,
    `<p style="font-size:14px;line-height:1.5;">${escapeHtml(input.assignedByName)} asked you to pick this request:</p>
     <ul style="font-size:14px;line-height:1.6;padding-left:20px;">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
     ${input.note ? `<p style="font-size:14px;line-height:1.5;">Note: “${escapeHtml(input.note)}”</p>` : ''}
     <p style="font-size:14px;line-height:1.5;">Record what you picked on the Stock screen (Requests tab). Someone else counts it in at the POS.</p>
     <p style="text-align:center;margin:24px 0;"><a href="${link}" style="display:inline-block;background:#b08968;color:#fffdfa;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:6px;font-size:14px;">Open Stock</a></p>`,
  );
  const text = [
    `${input.assignedByName} asked you to pick stock request #${input.requestNumber}:`,
    ...items.map((i) => `- ${i}`),
    ...(input.note ? [`Note: "${input.note}"`] : []),
    '',
    `Record what you picked on the Stock screen: ${link}`,
  ].join('\n');
  return { subject, html, text };
}

/** Look up the request and the picker's personal email, then send. Never throws. */
export async function sendStockAssignedEmail(
  admin: SupabaseClient,
  args: { requestId: string; assigneeId: string; assignedByName: string },
): Promise<EmailOutcome> {
  try {
    const [reqRes, accountRes] = await Promise.all([
      admin
        .from('stock_requests')
        .select('request_number, note, stock_request_lines(qty_requested, inventory_items(name, unit))')
        .eq('id', args.requestId)
        .maybeSingle(),
      admin.from('staff_accounts').select('personal_email').eq('user_id', args.assigneeId).maybeSingle(),
    ]);
    type ReqRow = {
      request_number: number;
      note: string | null;
      stock_request_lines: { qty_requested: number; inventory_items: { name: string; unit: string } | null }[] | null;
    };
    const req = reqRes.data as ReqRow | null;
    if (!req) return { kind: 'stock_assigned', status: 'skipped', detail: 'request not found' };
    const content = renderStockAssignedEmail({
      requestId: args.requestId,
      requestNumber: req.request_number,
      note: req.note ?? '',
      assignedByName: args.assignedByName,
      lines: (req.stock_request_lines ?? [])
        .map((l) => ({ name: l.inventory_items?.name ?? 'Item', unit: l.inventory_items?.unit ?? '', qty: Number(l.qty_requested) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
    return await sendStaffEmail(admin, {
      userId: args.assigneeId,
      kind: 'stock_assigned',
      ref: args.requestId,
      to: (accountRes.data as { personal_email?: string | null } | null)?.personal_email,
      ...content,
    });
  } catch (err) {
    console.error('sendStockAssignedEmail failed', err);
    return { kind: 'stock_assigned', status: 'failed', detail: 'unexpected error' };
  }
}
