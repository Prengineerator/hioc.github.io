// Owner → Marketing (docs/MARKETING-AGENT-SPEC.md §7). The page itself is a thin
// server shell: it applies the dark-launch flag and gives the client dashboard the
// <Suspense> boundary Next requires around useSearchParams (the tabs live in
// `?tab=`). Everything interactive is in components/owner/marketing.

import { Suspense } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { MarketingDashboard } from '@/components/owner/marketing/MarketingDashboard';
import { flags } from '@/lib/flags';

export const dynamic = 'force-dynamic';

export default function OwnerMarketingPage() {
  if (!flags.marketing) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-md border border-line bg-cream p-6 shadow-sm">
          <h1 className="text-xl font-bold text-charcoal">Marketing isn&apos;t enabled</h1>
          <p className="mt-2 text-sm text-charcoal">
            This part of the dashboard is switched off. To turn it on, set{' '}
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">NEXT_PUBLIC_FLAG_MARKETING=true</code> in your Vercel project settings and redeploy. Full steps are in{' '}
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">docs/MARKETING-AGENT-SETUP.md</code>.
          </p>
          <p className="mt-2 text-sm text-muted">Turning it on does not send anything: sending has its own switch, which starts off.</p>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<Spinner label="Loading marketing…" />}>
      <MarketingDashboard />
    </Suspense>
  );
}
