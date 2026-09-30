'use client';

// "Send test to my phone" — one real WhatsApp message, with sample values, through
// the template as currently edited (unsaved changes included), so the owner sees
// exactly what customers will see before a single customer is messaged. Used by
// the playbook cards and the new-campaign wizard. It is not logged as a
// recipient and never counts as a campaign (POST /api/owner/marketing/test-send).

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { normalizeIndianMobile } from '@/lib/phone';
import { parseTemplate } from '@/lib/marketing/parse';
import type { TestSendBody, TestSendResult } from '@/lib/marketing/types';
import { API, requestJson } from './api';
import { draftToTemplateInput, type TemplateDraft } from './drafts';

export function TestSend({ template, allowHeadline = false }: { template: TemplateDraft; /** Manual campaigns may use the `headline` variable; playbooks may not. */ allowHeadline?: boolean }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const send = async () => {
    setResult(null);
    const parsed = parseTemplate(draftToTemplateInput(template), { allowHeadline });
    if (!parsed.ok) {
      setResult({ ok: false, text: parsed.error });
      return;
    }
    let to: string | undefined;
    if (phone.trim() !== '') {
      const n = normalizeIndianMobile(phone);
      if (!n) {
        setResult({ ok: false, text: 'That does not look like an Indian mobile number. Leave it empty to use the number on your own profile.' });
        return;
      }
      to = `+91${n}`;
    }
    setBusy(true);
    const body: TestSendBody = { template: parsed.value, ...(to ? { phone: to } : {}) };
    const r = await requestJson<TestSendResult>(API.testSend, { method: 'POST', body });
    setBusy(false);
    if (!r.ok) setResult({ ok: false, text: r.error.message });
    else if (r.data.ok) setResult({ ok: true, text: 'Sent. It should reach WhatsApp within a minute. Check that it reads and looks right, including the Order now button.' });
    else setResult({ ok: false, text: r.data.error || 'WhatsApp did not accept the test message.' });
  };

  return (
    <div className="mt-4 rounded-md border border-line bg-white p-4">
      <p className="text-sm font-bold text-charcoal">Try it on your phone</p>
      <p className="mt-0.5 text-xs text-muted">
        Sends one real WhatsApp message with sample values (name “Asha”, sample offer and code) using the template above, including edits you have not saved. It uses one message from your WhatsApp account (about ₹1), is not counted as a campaign and does not use up your monthly budget. You can send 5 an hour.
      </p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-64">
          <Input
            label="Send to (optional)"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Default: the number on your profile"
            hint="Another number works only if that person has opted in (they can send START to your business number first)."
          />
        </div>
        <Button variant="secondary" onClick={send} loading={busy}>
          Send test to my phone
        </Button>
      </div>
      {result ? (
        <p role="status" className={`mt-3 text-sm font-semibold ${result.ok ? 'text-green-800' : 'text-red-700'}`}>
          {result.ok ? '✓ ' : '✕ '}
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
