'use client';

// BILL-3 follow-up — the channel health from the delivery log, put on the screen
// where an owner actually goes to switch notifications on.
//
// The failure being closed: a cafe can believe bills are going out while the
// WhatsApp credentials were never set, and until now the only place that said so
// was a delivery log nobody opens until a customer complains. Settings is where
// someone sets this up, so Settings is where it has to say it isn't working.
//
// Read-only on purpose — these are deployment environment variables, not rows in
// store_settings, so the useful thing this can do is name them exactly and hand
// off to /owner/notifications for per-message detail. It reuses
// GET /api/owner/notifications rather than adding a second health endpoint, so
// the two screens can never disagree about what "configured" means.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { summarizeChannelHealth, type HealthSummary } from '@/components/owner/channelHealth';
import type { ChannelHealth } from '@/lib/notifications/health';

interface NotificationsResponse {
  health?: ChannelHealth[];
  provider_warning?: string | null;
}

export function ChannelHealthSummary() {
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    // limit=1: only `health` is wanted here — the rows belong to the log.
    fetch('/api/owner/notifications?limit=1', { cache: 'no-store' })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as NotificationsResponse & { error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Failed to read channel status');
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setSummary(summarizeChannelHealth(data.health ?? [], data.provider_warning ?? null));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to read channel status');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Bill delivery channels</h2>
        <Link href="/owner/notifications" className="text-sm font-bold text-charcoal hover:underline">
          Delivery log →
        </Link>
      </div>
      <p className="mb-4 text-sm text-muted">
        How a customer receives their bill after they pay. A channel with missing credentials sends
        nothing and logs nothing — it simply goes quiet, so check here before you promise a customer a
        WhatsApp bill. These are set in the deployment environment, not on this page.
      </p>

      {loading ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : error ? (
        <p className="text-sm font-medium text-red-700">{error}</p>
      ) : summary ? (
        <>
          <p
            className={
              summary.tone === 'attention'
                ? 'rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-800'
                : 'text-sm font-bold text-[#2f6b38]'
            }
          >
            {summary.headline}
          </p>

          <div className="mt-3 flex flex-col divide-y divide-[#f2efe9]">
            {summary.lines.map((line) => (
              <div
                key={line.channel}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
              >
                <div>
                  <span className="font-medium text-charcoal">{line.label}</span>
                  <span className="block text-xs text-muted">{line.detail}</span>
                  {line.warnings.map((w) => (
                    <span key={w} className="mt-1 block text-xs text-tan-dark">
                      ⚠ {w}
                    </span>
                  ))}
                </div>
                <span
                  className={
                    'shrink-0 self-start rounded-full px-2 py-0.5 text-xs font-bold ' +
                    (line.configured ? 'bg-[#e3efe4] text-[#2f6b38]' : 'bg-red-50 text-red-700')
                  }
                >
                  {line.configured ? 'Sending' : 'Off'}
                </span>
              </div>
            ))}
          </div>

          {summary.providerWarning ? (
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              ⚠ {summary.providerWarning}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
