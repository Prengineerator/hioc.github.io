'use client';

// Audience (spec §7.5): who you can message, who has said yes, where those yeses
// came from — and the one way new yeses arrive: the customer scanning a QR code.
// The owner can RECORD an opt-out but can never add an opt-in, and this page says
// why (consent law and WhatsApp policy), because the first thing an owner
// asks is "can't I just add my regulars?".

import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CAFE_NAME } from '@/lib/constants';
import { normalizeIndianMobileHonouringPlus, formatIndianMobileDisplay } from '@/lib/phone';
import {
  LIFECYCLE_STAGE_LABELS,
  type AudienceSummary,
  type MarketingTab,
} from '@/lib/marketing/types';
import { API, requestJson } from './api';
import { consentSourceLabel, formatCount, formatIstDateTime, formatPercent, inr } from './format';
import { useApi } from './hooks';
import { Kpi, Notice, Panel, Pill, ResourceGate, TabIntro } from './ui';

export function AudienceTab({ onNavigate }: { onNavigate: (tab: MarketingTab) => void }) {
  const audience = useApi<AudienceSummary>(API.audience);
  return (
    <div className="flex flex-col gap-5">
      <TabIntro title="Audience">
        Everyone we know, and how many of them have said yes to WhatsApp offers. Only customers who opted in are ever messaged.
      </TabIntro>
      <ResourceGate resource={audience} label="Loading your audience…">
        {(data) => <AudienceBody data={data} reload={audience.reload} onNavigate={onNavigate} />}
      </ResourceGate>
    </div>
  );
}

/** Exported for the render smoke test (tests/marketingDashboardRender.test.ts). */
export function AudienceBody({ data, reload, onNavigate }: { data: AudienceSummary; reload: () => void; onNavigate: (tab: MarketingTab) => void }) {
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Customers by stage" subtitle="“All” is every customer we can identify. “Opted in” is the part you are allowed to message.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-1 pr-3 font-semibold">Stage</th>
                <th className="py-1 pr-3 text-right font-semibold">All customers</th>
                <th className="py-1 pr-3 text-right font-semibold">Opted in</th>
                <th className="py-1 font-semibold">Share opted in</th>
              </tr>
            </thead>
            <tbody>
              {(data.stages ?? []).map((s) => {
                const share = s.all > 0 ? (s.opted_in / s.all) * 100 : 0;
                return (
                  <tr key={s.stage} className="border-t border-[#f2efe9]">
                    <td className="py-2 pr-3 text-charcoal">{LIFECYCLE_STAGE_LABELS[s.stage]}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatCount(s.all)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatCount(s.opted_in)}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-line" aria-hidden="true">
                          <div className="h-full rounded-full bg-tan" style={{ width: `${Math.min(100, Math.round(share))}%` }} />
                        </div>
                        <span className="text-xs text-muted">{s.all > 0 ? formatPercent(share) : '—'}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">{formatCount(data.total_customers)} customers in total.</p>
      </Panel>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Customers with points" value={formatCount(data.points.customers_with_balance)} />
        <Kpi label="Points outstanding" value={inr(data.points.outstanding_inr)} hint="what you would owe if all were used" />
        <Kpi label="Expiring in 7 days" value={inr(data.points.expiring_7d_inr)} hint={`${formatCount(data.points.expiring_7d_customers)} customers`} />
        <Kpi label="Opted in / out" value={`${formatCount(data.consent.opted_in)} / ${formatCount(data.consent.opted_out)}`} hint="customers who said yes / stop" />
      </div>

      <Panel title="Where the yeses come from">
        {(data.consent.by_source ?? []).length === 0 ? (
          <p className="text-sm text-muted">No opt-ins or opt-outs recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-1 pr-3 font-semibold">How</th>
                  <th className="py-1 pr-3 text-right font-semibold">Opted in</th>
                  <th className="py-1 text-right font-semibold">Opted out</th>
                </tr>
              </thead>
              <tbody>
                {(data.consent.by_source ?? []).map((s) => (
                  <tr key={s.source} className="border-t border-[#f2efe9]">
                    <td className="py-2 pr-3 text-charcoal">{consentSourceLabel(s.source)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatCount(s.opted_in)}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{formatCount(s.opted_out)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="mb-2 mt-5 text-sm font-bold text-charcoal">Last 30 days</h3>
        {(data.consent.recent_events ?? []).length === 0 ? (
          <p className="text-sm text-muted">No changes in the last 30 days.</p>
        ) : (
          <div className="max-h-80 overflow-auto rounded-md border border-line">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="sticky top-0 bg-cream">
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-semibold">When (IST)</th>
                  <th className="px-3 py-2 font-semibold">Customer</th>
                  <th className="px-3 py-2 font-semibold">Change</th>
                  <th className="px-3 py-2 font-semibold">How</th>
                </tr>
              </thead>
              <tbody>
                {(data.consent.recent_events ?? []).map((e, i) => (
                  <tr key={`${e.created_at}-${i}`} className="border-t border-[#f2efe9]">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-charcoal">{formatIstDateTime(e.created_at)}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{e.phone_masked}</td>
                    <td className="px-3 py-2">
                      <Pill tone={e.action === 'opt_in' ? 'good' : 'neutral'}>{e.action === 'opt_in' ? 'Opted in' : 'Opted out'}</Pill>
                    </td>
                    <td className="px-3 py-2 text-xs text-charcoal">{consentSourceLabel(e.source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">Numbers are partly hidden here: this list is for spotting patterns, not for looking people up.</p>
      </Panel>

      <OptInCard data={data} onNavigate={onNavigate} />

      <OptOutForm onDone={reload} />

      <Notice tone="info" title="Why can’t I add customers myself?">
        <p>
          A customer has to say yes themselves. India’s data-protection law (the DPDP Act) needs consent that is free, specific and given by a clear action, and WhatsApp’s own rules need the same. A phone list you type or upload would not count as consent, and messaging people who did not ask is the quickest way to get your WhatsApp number restricted.
        </p>
        <p className="mt-2">
          They can say yes by scanning your QR code below, from the card after they order, or in their Account. Opting out is just as easy for them, and it is honoured straight away.
        </p>
      </Notice>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opt-in link, QR and printable card
// ---------------------------------------------------------------------------

function OptInCard({ data, onNavigate }: { data: AudienceSummary; onNavigate: (tab: MarketingTab) => void }) {
  const url = data.optin_url;
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // The QR is drawn in the browser (the `qrcode` package), so the link never goes to an outside image service.
  useEffect(() => {
    let cancelled = false;
    if (!url) {
      setQr(null);
      return;
    }
    QRCode.toDataURL(url, { width: 600, margin: 1, errorCorrectionLevel: 'M' })
      .then((d) => {
        if (!cancelled) setQr(d);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!url) {
    return (
      <Panel title="Get customers to opt in">
        <Notice
          tone="warn"
          title="Your WhatsApp business number is not set"
          action={
            <Button size="sm" onClick={() => onNavigate('settings')}>
              Open Settings
            </Button>
          }
        >
          Add it under Settings → Your WhatsApp number and you will get a link and a printable QR card here.
        </Notice>
      </Panel>
    );
  }

  const displayNumber = formatIndianMobileDisplay(data.whatsapp_business_number) ?? data.whatsapp_business_number;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
      window.prompt('Copy this link:', url);
    }
  };

  const card = (
    <div className="optin-card">
      <p className="optin-card__brand">{CAFE_NAME}</p>
      <h3 className="optin-card__title">Scan to get HIOC offers on WhatsApp</h3>
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt="QR code that opens WhatsApp with START ready to send" className="optin-card__qr" />
      ) : (
        <div className="optin-card__qr" />
      )}
      <p className="optin-card__step">Tap send on the message that opens. That is all.</p>
      <p className="optin-card__small">
        Or send <strong>START</strong> to {displayNumber} on WhatsApp.
      </p>
      <p className="optin-card__fine">At most one message a week. Reply STOP any time to unsubscribe.</p>
    </div>
  );

  return (
    <Panel title="Get customers to opt in" subtitle="Put this QR on tables and at the counter. Scanning it opens WhatsApp with START ready to send; the customer taps send and they are in.">
      <div className="grid gap-5 md:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="optin-screen-card mx-auto w-full max-w-[340px] rounded-md border border-line bg-white p-4">{card}</div>
        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">Your opt-in link</p>
            <a href={url} target="_blank" rel="noopener noreferrer" className="break-all text-sm font-semibold text-tan-dark hover:underline">
              {url}
            </a>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={copy}>
              {copied ? '✓ Copied' : 'Copy link'}
            </Button>
            <Button size="sm" onClick={() => window.print()} disabled={!qr}>
              Print the card
            </Button>
            {qr ? (
              <a
                href={qr}
                download="hioc-whatsapp-optin-qr.png"
                className="inline-flex min-h-[44px] items-center justify-center rounded-md px-3 py-1.5 text-sm font-semibold text-charcoal hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
              >
                Download the QR image
              </a>
            ) : null}
          </div>
          <p className="text-xs text-muted">
            Printing: choose A5 or “fit to page”. The card prints on its own, without the rest of this page. Test it once with your own phone before you print a stack.
          </p>
        </div>
      </div>

      {/* Print-only copy of the card, a direct child of <body>, so the print rules can hide the rest of the app (same approach as the table QR cards). */}
      {mounted && qr
        ? createPortal(
            <div data-optin-print-portal="" className="optin-print-root">
              {card}
            </div>,
            document.body,
          )
        : null}
      <style>{OPTIN_CSS}</style>
    </Panel>
  );
}

const OPTIN_CSS = `
.optin-card { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; background: #fff; color: #232325; }
.optin-card__brand { font-size: 13px; font-weight: 800; letter-spacing: 0.25em; color: #6b6560; }
.optin-card__title { font-size: 22px; font-weight: 800; line-height: 1.2; }
.optin-card__qr { width: 100%; max-width: 260px; aspect-ratio: 1 / 1; image-rendering: pixelated; }
.optin-card__step { font-size: 15px; font-weight: 700; }
.optin-card__small { font-size: 13px; }
.optin-card__fine { font-size: 11px; color: #6b6560; }
.optin-print-root { display: none; }

@media print {
  @page { size: A5 portrait; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not([data-optin-print-portal]) { display: none !important; }
  .optin-print-root { display: flex !important; align-items: center; justify-content: center; width: 148mm; height: 210mm; box-sizing: border-box; padding: 14mm; }
  .optin-print-root .optin-card { gap: 6mm; }
  .optin-print-root .optin-card__brand { font-size: 16pt; }
  .optin-print-root .optin-card__title { font-size: 26pt; }
  .optin-print-root .optin-card__qr { max-width: 90mm; }
  .optin-print-root .optin-card__step { font-size: 15pt; }
  .optin-print-root .optin-card__small { font-size: 12pt; }
  .optin-print-root .optin-card__fine { font-size: 10pt; }
}
`;

// ---------------------------------------------------------------------------
// Record an opt-out
// ---------------------------------------------------------------------------

function OptOutForm({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    const n = normalizeIndianMobileHonouringPlus(phone);
    if (!n) {
      setMessage({ ok: false, text: 'Enter a valid 10-digit Indian mobile number.' });
      return;
    }
    setBusy(true);
    const r = await requestJson<{ ok: boolean }>(API.optOut, { method: 'POST', body: { phone: `+91${n}` } });
    setBusy(false);
    if (!r.ok) {
      setMessage({ ok: false, text: r.error.message });
      return;
    }
    setPhone('');
    setMessage({
      ok: true,
      text: `Done. +91 ${n.slice(0, 5)} ${n.slice(5)} will not get any marketing messages from us. They can join again any time by sending START on WhatsApp.`,
    });
    onDone();
  };

  return (
    <Panel
      title="Record an opt-out"
      subtitle="A customer told you in person they don’t want offers? Enter their number and they are removed straight away, including from any campaign that has not sent yet."
    >
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
        <div className="sm:w-72">
          <Input
            label="Customer’s mobile number"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="98765 43210"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setMessage(null);
            }}
          />
        </div>
        <Button type="submit" variant="secondary" loading={busy}>
          Record opt-out
        </Button>
      </form>
      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className={`mt-3 text-sm font-semibold ${message.ok ? 'text-green-800' : 'text-red-700'}`}>
          {message.ok ? '✓ ' : '✕ '}
          {message.text}
        </p>
      ) : null}
    </Panel>
  );
}
