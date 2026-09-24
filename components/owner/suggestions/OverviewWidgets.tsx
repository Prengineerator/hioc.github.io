// Presentational pieces for /owner/suggestions' Overview tab (SUG-10). Pure
// (no hooks) so they render inside the async server page, matching
// components/owner/dashboard.tsx's own house style.

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card } from '@/components/owner/dashboard';
import type { Mood, SuggestionDigestRow, SuggestionStats } from '@/lib/suggest/types';

export type WindowKey = 'today' | '7d' | '30d';

const WINDOW_OPTIONS: { key: WindowKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

const MOOD_LABELS: Record<Mood, string> = {
  boost: 'Need a boost',
  cosy: 'Calm & cosy',
  celebrate: 'Celebrating',
  comfort: 'Need comfort',
  cool: 'Cool me down',
  surprise: 'Surprise me',
};

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

export function WindowTabs({ active }: { active: WindowKey }) {
  return (
    <div className="flex gap-1 text-sm font-bold">
      {WINDOW_OPTIONS.map((o) => (
        <Link
          key={o.key}
          href={`/owner/suggestions?window=${o.key}`}
          className={
            'rounded-md px-3 py-1.5 ' + (active === o.key ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-[#f2efe9]')
          }
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

export function FunnelCard({ stats }: { stats: SuggestionStats }) {
  const steps: { label: string; value: number }[] = [
    { label: 'Sessions', value: stats.sessions },
    { label: 'Added to cart', value: stats.sessionsWithAdd },
    { label: 'Checkout started', value: stats.sessionsCheckout },
    { label: 'Ordered', value: stats.sessionsOrdered },
  ];
  return (
    <Card title="Funnel">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {steps.map((s) => (
          <div key={s.label} className="rounded-md bg-[#f2efe9] p-3 text-center">
            <p className="text-xl font-bold text-charcoal">{s.value}</p>
            <p className="text-xs uppercase text-muted">{s.label}</p>
            <p className="text-xs text-muted">{pct(s.value, stats.sessions)}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function RevenueCard({ stats }: { stats: SuggestionStats }) {
  return (
    <Card title="Attributed revenue">
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-xl font-bold text-charcoal">₹{stats.attributedRevenueInr}</p>
          <p className="text-xs uppercase text-muted">Revenue</p>
        </div>
        <div>
          <p className="text-xl font-bold text-charcoal">
            {stats.suggestionAovInr === null ? '—' : `₹${stats.suggestionAovInr}`}
          </p>
          <p className="text-xs uppercase text-muted">Suggestion AOV</p>
        </div>
        <div>
          <p className="text-xl font-bold text-charcoal">{stats.webAovInr === null ? '—' : `₹${stats.webAovInr}`}</p>
          <p className="text-xs uppercase text-muted">Web AOV</p>
        </div>
      </div>
    </Card>
  );
}

export function MoodMixCard({ stats }: { stats: SuggestionStats }) {
  const max = Math.max(...stats.moodMix.map((m) => m.sessions), 1);
  return (
    <Card title="Mood mix & conversion">
      <div className="flex flex-col gap-2">
        {stats.moodMix.map((m) => (
          <div key={m.mood} className="flex items-center gap-2 text-sm">
            <span className="w-32 shrink-0 text-charcoal">{MOOD_LABELS[m.mood]}</span>
            <div className="h-4 flex-1 rounded bg-[#f2efe9]">
              <div className="h-4 rounded bg-tan" style={{ width: `${(m.sessions / max) * 100}%` }} />
            </div>
            <span className="w-28 shrink-0 text-right text-xs text-muted">
              {m.sessions} · {pct(m.ordered, m.sessions)} ordered
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function TopPicksTable({ stats }: { stats: SuggestionStats }) {
  if (stats.topItems.length === 0) {
    return (
      <Card title="Top picks">
        <p className="py-6 text-center text-sm text-muted">No suggestions shown yet.</p>
      </Card>
    );
  }
  return (
    <Card title="Top picks">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-[#e5e5e5] text-left text-xs uppercase text-muted">
              <th className="py-1 font-bold">Item</th>
              <th className="py-1 text-right font-bold">Suggested</th>
              <th className="py-1 text-right font-bold">Added</th>
              <th className="py-1 text-right font-bold">Ordered</th>
              <th className="py-1 text-right font-bold">Hit rate</th>
              <th className="py-1 text-right font-bold">👍</th>
              <th className="py-1 text-right font-bold">👎</th>
            </tr>
          </thead>
          <tbody>
            {stats.topItems.map((i) => (
              <tr key={i.menuItemId} className="border-b border-[#f2efe9]">
                <td className="py-1.5 text-charcoal">
                  {i.name}
                  {i.suggested > 0 && i.added === 0 && (
                    <span className="ml-2 rounded-full bg-[#f6d9d9] px-2 py-0.5 text-[10px] font-bold text-red-800">
                      never added
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right text-muted">{i.suggested}</td>
                <td className="py-1.5 text-right text-muted">{i.added}</td>
                <td className="py-1.5 text-right text-muted">{i.ordered}</td>
                <td className="py-1.5 text-right text-muted">{pct(i.added, i.suggested)}</td>
                <td className="py-1.5 text-right text-muted">{i.up}</td>
                <td className="py-1.5 text-right text-muted">{i.down}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function PersonalisedCard({ stats }: { stats: SuggestionStats }) {
  return (
    <Card title="Personalised vs guest">
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-md bg-[#f2efe9] p-3">
          <p className="text-xl font-bold text-charcoal">{stats.personalised.sessions}</p>
          <p className="text-xs uppercase text-muted">Personalised sessions</p>
          <p className="text-xs text-muted">{pct(stats.personalised.ordered, stats.personalised.sessions)} ordered</p>
        </div>
        <div className="rounded-md bg-[#f2efe9] p-3">
          <p className="text-xl font-bold text-charcoal">{stats.guest.sessions}</p>
          <p className="text-xs uppercase text-muted">Guest sessions</p>
          <p className="text-xs text-muted">{pct(stats.guest.ordered, stats.guest.sessions)} ordered</p>
        </div>
      </div>
    </Card>
  );
}

export function EngineHealthCard({ stats, dailyCapUsd }: { stats: SuggestionStats; dailyCapUsd: number }) {
  return (
    <Card title="Engine health">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-md bg-[#f2efe9] p-3 text-center">
          <p className="text-xl font-bold text-charcoal">{Math.round(stats.llmShare * 100)}%</p>
          <p className="text-xs uppercase text-muted">Answered by AI</p>
        </div>
        <div className="rounded-md bg-[#f2efe9] p-3 text-center">
          <p className="text-xl font-bold text-charcoal">{stats.latencyP50Ms === null ? '—' : `${stats.latencyP50Ms}ms`}</p>
          <p className="text-xs uppercase text-muted">Latency p50</p>
        </div>
        <div className="rounded-md bg-[#f2efe9] p-3 text-center">
          <p className="text-xl font-bold text-charcoal">{stats.latencyP90Ms === null ? '—' : `${stats.latencyP90Ms}ms`}</p>
          <p className="text-xs uppercase text-muted">Latency p90</p>
        </div>
        <div className="rounded-md bg-[#f2efe9] p-3 text-center">
          <p className="text-xl font-bold text-charcoal">${stats.costUsd.toFixed(2)}</p>
          <p className="text-xs uppercase text-muted">Cost vs ${dailyCapUsd.toFixed(0)}/day cap</p>
        </div>
      </div>
      {stats.fallbackReasons.length > 0 && (
        <div className="mt-3">
          <h3 className="mb-1 text-xs font-bold uppercase text-muted">Fallback reasons</h3>
          <ul className="flex flex-wrap gap-2 text-xs text-muted">
            {stats.fallbackReasons.map((r) => (
              <li key={r.reason} className="rounded-full bg-[#f2efe9] px-2 py-0.5">
                {r.reason} × {r.count}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function DigestCard({ digest }: { digest: SuggestionDigestRow | null }) {
  return (
    <Card title="Weekly digest">
      {!digest ? (
        <p className="py-6 text-center text-sm text-muted">No digest yet — the Monday cron writes one automatically.</p>
      ) : (
        <div>
          <p className="mb-1 text-xs uppercase text-muted">
            Week of {digest.week_start} · {digest.source === 'llm' ? 'Sonnet' : 'template'}
          </p>
          <p className="whitespace-pre-line text-sm text-charcoal">{digest.summary}</p>
        </div>
      )}
    </Card>
  );
}
