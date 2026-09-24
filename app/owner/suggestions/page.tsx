// Phase 7 · SUG-10 — the owner Suggestions dashboard
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §7). Server component: window
// selector (Today/7 days/30 days via ?window=) plus a Traits tab (?tab=traits)
// — the Traits tab is always reachable, flag or no flag, because the owner
// has to tag the menu before NEXT_PUBLIC_FLAG_SUGGEST can go on (Gate 7A).

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card } from '@/components/owner/dashboard';
import {
  DigestCard,
  EngineHealthCard,
  FunnelCard,
  MoodMixCard,
  PersonalisedCard,
  RevenueCard,
  TopPicksTable,
  WindowTabs,
  type WindowKey,
} from '@/components/owner/suggestions/OverviewWidgets';
import { TraitsTab } from '@/components/owner/suggestions/TraitsTab';
import { flags } from '@/lib/flags';
import { startOfTodayIstIso } from '@/lib/api/date';
import { dailyBudgetUsdMicros } from '@/lib/suggest/models';
import { getLatestDigest, getSuggestionStats } from '@/lib/suggest/queries';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

function windowStartFor(key: WindowKey): string {
  if (key === 'today') return startOfTodayIstIso();
  return new Date(Date.now() - (key === '30d' ? 30 : 7) * DAY_MS).toISOString();
}

function parseWindow(raw: string | string[] | undefined): WindowKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === 'today' || v === '30d' ? v : '7d';
}

function TabNav({ tab }: { tab: 'overview' | 'traits' }) {
  return (
    <nav className="flex gap-1 text-sm font-bold">
      <Link
        href="/owner/suggestions"
        className={'rounded-md px-3 py-1.5 ' + (tab === 'overview' ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-[#f2efe9]')}
      >
        Overview
      </Link>
      <Link
        href="/owner/suggestions?tab=traits"
        className={'rounded-md px-3 py-1.5 ' + (tab === 'traits' ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-[#f2efe9]')}
      >
        Traits
      </Link>
    </nav>
  );
}

export default async function OwnerSuggestionsPage({
  searchParams,
}: {
  searchParams?: { window?: string; tab?: string };
}) {
  const tab: 'overview' | 'traits' = searchParams?.tab === 'traits' ? 'traits' : 'overview';

  if (tab === 'traits') {
    return (
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-charcoal">Suggestions</h1>
          <TabNav tab={tab} />
        </div>
        <TraitsTab />
      </div>
    );
  }

  const windowKey = parseWindow(searchParams?.window);
  const windowStart = windowStartFor(windowKey);

  const [{ stats, missingTables }, digest] = await Promise.all([getSuggestionStats(windowStart), getLatestDigest()]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-charcoal">Suggestions</h1>
        <TabNav tab={tab} />
      </div>

      {!flags.suggest && (
        <Card title="Dark-launched">
          <p className="text-sm text-muted">
            &ldquo;Help me choose&rdquo; isn&apos;t live for customers yet (NEXT_PUBLIC_FLAG_SUGGEST is off). Tag every
            item on the Traits tab first — the flag can go on once Gate 7A and 7B pass.
          </p>
        </Card>
      )}

      {missingTables && (
        <Card title="Not set up yet">
          <p className="text-sm text-muted">
            The suggestion-engine tables aren&apos;t migrated on this database yet — run
            supabase/2026-09-suggestion-engine.sql to see real numbers here.
          </p>
        </Card>
      )}

      <WindowTabs active={windowKey} />
      <FunnelCard stats={stats} />
      <RevenueCard stats={stats} />
      <MoodMixCard stats={stats} />
      <TopPicksTable stats={stats} />
      <PersonalisedCard stats={stats} />
      <EngineHealthCard stats={stats} dailyCapUsd={dailyBudgetUsdMicros() / 1_000_000} />
      <DigestCard digest={digest} />
    </div>
  );
}
