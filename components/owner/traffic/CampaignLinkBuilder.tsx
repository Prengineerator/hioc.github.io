'use client';

// Owner → Traffic: make a tagged link (docs/TRAFFIC-TRACKING.md). A link with
// utm_* tags is counted under its own source and campaign on the Traffic page,
// which is the only way to tell an Instagram bio from an Instagram story, or a
// flyer QR code from a typed address: both of those otherwise arrive with the
// same (or no) linking site.

import { useId, useMemo, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { cleanUtmValue } from '@/lib/traffic/classify';

const PAGES = [
  { value: '/menu', label: 'Menu (order ahead)' },
  { value: '/shop', label: 'Shop (Instant Coffee)' },
  { value: '/', label: 'Home page' },
];

const SOURCES = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'google', label: 'Google (Maps / Business Profile)' },
  { value: 'email', label: 'Email' },
  { value: 'qr', label: 'QR code / print' },
  { value: 'other', label: 'Something else…' },
];

/** Tags as they will be stored: lower case, spaces as hyphens. */
function tag(raw: string): string | null {
  const v = cleanUtmValue(raw);
  return v ? v.replace(/ /g, '-') : null;
}

export function buildCampaignLink(origin: string, page: string, tags: { source: string; medium: string; campaign: string }): string {
  const url = new URL(page, origin);
  const source = tag(tags.source);
  const medium = tag(tags.medium);
  const campaign = tag(tags.campaign);
  if (source) url.searchParams.set('utm_source', source);
  if (medium) url.searchParams.set('utm_medium', medium);
  if (campaign) url.searchParams.set('utm_campaign', campaign);
  return url.toString();
}

export function CampaignLinkBuilder({ origin }: { origin: string }) {
  const [page, setPage] = useState('/shop');
  const [source, setSource] = useState('instagram');
  const [otherSource, setOtherSource] = useState('');
  const [medium, setMedium] = useState('bio');
  const [campaign, setCampaign] = useState('');
  const [copied, setCopied] = useState<'ok' | 'select' | null>(null);
  const outputId = useId();

  const link = useMemo(
    () => buildCampaignLink(origin, page, { source: source === 'other' ? otherSource : source, medium, campaign }),
    [origin, page, source, otherSource, medium, campaign],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('ok');
    } catch {
      const el = document.getElementById(outputId) as HTMLInputElement | null;
      el?.focus();
      el?.select();
      setCopied('select');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-charcoal">
        Put a tagged link wherever you share the site: your Instagram bio, a story, a WhatsApp status, the Google
        Business Profile, a QR code on the jar or a flyer. Visits and orders from it then show under its own source and
        campaign below, instead of as Direct.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select id="traffic-link-page" label="Page" options={PAGES} value={page} onChange={(e) => { setPage(e.target.value); setCopied(null); }} />
        <Select id="traffic-link-source" label="Where it goes" options={SOURCES} value={source} onChange={(e) => { setSource(e.target.value); setCopied(null); }} />
        <Input
          id="traffic-link-medium"
          label="Placement"
          hint="bio, story, post, status, flyer, jar…"
          value={medium}
          maxLength={60}
          onChange={(e) => { setMedium(e.target.value); setCopied(null); }}
        />
        <Input
          id="traffic-link-campaign"
          label="Campaign (optional)"
          hint="diwali-offer, launch-week…"
          value={campaign}
          maxLength={60}
          onChange={(e) => { setCampaign(e.target.value); setCopied(null); }}
        />
      </div>
      {source === 'other' ? (
        <div className="sm:max-w-xs">
          <Input
            id="traffic-link-other-source"
            label="Source name"
            hint="youtube, zomato, newspaper…"
            value={otherSource}
            maxLength={60}
            onChange={(e) => { setOtherSource(e.target.value); setCopied(null); }}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={outputId} className="text-sm font-semibold text-charcoal">
            Your link
          </label>
          <input
            id={outputId}
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-1 min-h-[44px] w-full rounded-md border border-line bg-white px-3 py-2 font-mono text-sm text-charcoal outline-none focus:border-tan-dark"
          />
        </div>
        <button
          type="button"
          onClick={copy}
          className="min-h-[44px] rounded-md bg-charcoal px-4 py-2 text-sm font-bold text-cream hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-tan-dark"
        >
          Copy link
        </button>
      </div>
      <p className="text-xs text-muted" aria-live="polite">
        {copied === 'ok' ? 'Copied.' : copied === 'select' ? 'Selected — press Ctrl+C (or long-press → Copy) to copy it.' : ''}
      </p>
    </div>
  );
}
