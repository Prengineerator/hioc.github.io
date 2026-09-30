import { NextResponse } from 'next/server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { parseTemplate } from '@/lib/marketing/parse';
import { buildVars, renderPreview } from '@/lib/marketing/templates';
import { TEMPLATE_TOKEN_SAMPLES } from '@/lib/marketing/types';
import type { TestSendResult } from '@/lib/marketing/types';
import { loadConsentState } from '@/lib/marketing/server/consent';
import { ownerRoute } from '@/lib/marketing/server/http';
import { marketingAdmin, toE164 } from '@/lib/marketing/server/repo';
import { whatsappAdapter } from '@/lib/notifications/adapters';
import { whatsappReminderHealth } from '@/lib/notifications/health';

export const dynamic = 'force-dynamic';

// POST /api/owner/marketing/test-send — sends ONE template to a phone with sample
// values ("Asha", "80", "WBK7M3QX", …) so the owner can see it before a campaign uses it.
// Not logged as a recipient, costs nothing against the budget, and is rate-limited to 5
// an hour. OWNER ONLY.
//
// A test is still a marketing message, and consent is not the owner's to waive: it may go
// to the owner's OWN profile phone (the default), or to a number that has opted in
// itself (say START from a second phone first). Never to an arbitrary number.
export async function POST(request: Request) {
  return ownerRoute(async (owner) => {
    const body = await parseJsonBody(request);
    if (!body) return errorResponse(400, 'Request body must be a JSON object');

    const template = parseTemplate(body.template, { allowHeadline: true });
    if (!template.ok) return errorResponse(400, template.error);
    if (template.value.name === '') return errorResponse(400, 'Enter the template name first.');

    const admin = marketingAdmin();
    const { data: profile } = await admin.from('profiles').select('phone').eq('id', owner.id).maybeSingle();
    const ownPhone = toE164((profile as { phone?: string | null } | null)?.phone);

    let target = ownPhone;
    if (typeof body.phone === 'string' && body.phone.trim() !== '') {
      target = toE164(body.phone);
      if (!target) return errorResponse(400, 'That is not a valid phone number.');
    }
    if (!target) return errorResponse(400, 'Add a phone number to your profile, or enter the number to test on.');

    if (target !== ownPhone) {
      const state = await loadConsentState(admin, target);
      if (!state.opted_in || state.opt_out_listed) {
        return errorResponse(400, 'That number has not opted in to offers. Test on your own number, or ask them to send START to the business number first.');
      }
    }

    if (!(await rateLimitOk(`mkt-test:${owner.id}`, 5, 3600))) {
      return errorResponse(429, 'You can send 5 test messages an hour. Please try again later.');
    }

    // Marketing never goes through getAdapter()'s stub: it would report "sent" for a message nobody received.
    const health = whatsappReminderHealth();
    if (!health.configured) {
      return NextResponse.json({ ok: false, error: `WhatsApp is not configured — set ${health.missing.join(', ')}.` } satisfies TestSendResult);
    }

    const vars = buildVars(template.value.vars, TEMPLATE_TOKEN_SAMPLES);
    const result = await whatsappAdapter.send({
      to: target,
      channel: 'whatsapp',
      body: renderPreview(template.value.body_preview, vars),
      templateName: template.value.name,
      templateLang: template.value.lang,
      templateVars: vars,
      // The URL button's suffix: /r/TEST is an unknown token, which just lands on the menu.
      templateButtons: template.value.url_button ? [{ index: 0, text: 'TEST' }] : undefined,
    });
    return NextResponse.json(
      (result.ok ? { ok: true, provider_ref: result.providerRef } : { ok: false, error: result.error }) satisfies TestSendResult,
    );
  });
}
