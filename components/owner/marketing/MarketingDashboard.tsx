'use client';

// /owner/marketing — the shell: seven tabs held in `?tab=` (so a reload, a
// bookmark or a link from another page lands on the same tab), one campaign
// drawer that any tab can open, and the overview fetch that feeds the Approvals
// badge and the "is sending on?" banner.
//
// Every tab fetches its own data (each handles loading, errors and the
// migration-missing 409 through ResourceGate). A change that other tabs care about
// — approving a campaign, flipping the kill switch — reloads the overview so the
// badge and banner never show yesterday's answer.

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MARKETING_TABS, type MarketingOverview, type MarketingTab, type PlaybookKey } from '@/lib/marketing/types';
import { API } from './api';
import { ApprovalsTab } from './ApprovalsTab';
import { AudienceTab } from './AudienceTab';
import { CampaignDrawer } from './CampaignDrawer';
import { CampaignsTab } from './CampaignsTab';
import { CostsTab } from './CostsTab';
import { tabFromParam, tabHref } from './format';
import { useApi } from './hooks';
import { OverviewTab } from './OverviewTab';
import { PlaybooksTab } from './PlaybooksTab';
import { SettingsTab } from './SettingsTab';

export function MarketingDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = tabFromParam(params.get('tab'));

  const overview = useApi<MarketingOverview>(API.overview);
  const [focusPlaybook, setFocusPlaybook] = useState<PlaybookKey | null>(null);
  const [openCampaign, setOpenCampaign] = useState<string | null>(null);
  // Bumped when something the visible tab's lists depend on changed (a campaign was stopped).
  const [refresh, setRefresh] = useState(0);

  const goTo = useCallback(
    (next: MarketingTab, playbook?: PlaybookKey) => {
      setFocusPlaybook(playbook ?? null);
      router.replace(tabHref(pathname, next), { scroll: false });
    },
    [router, pathname],
  );

  // A tab is a new page as far as the owner is concerned: start at its top. (An insight that names
  // a playbook scrolls to that card instead — see PlaybookCard.)
  useEffect(() => {
    if (focusPlaybook === null) window.scrollTo({ top: 0 });
  }, [tab, focusPlaybook]);

  const reloadOverview = overview.reload;
  const pending = overview.state.status === 'ready' ? overview.state.data.pending_approvals : 0;
  const sendingEnabled = overview.state.status === 'ready' ? overview.state.data.enabled : null;

  const content = (() => {
    switch (tab) {
      case 'overview':
        return <OverviewTab overview={overview} onNavigate={goTo} onOpenCampaign={setOpenCampaign} />;
      case 'approvals':
        return <ApprovalsTab sendingEnabled={sendingEnabled} onChanged={reloadOverview} onOpenCampaign={setOpenCampaign} />;
      case 'playbooks':
        return <PlaybooksTab focusKey={focusPlaybook} onOpenCampaign={setOpenCampaign} onChanged={reloadOverview} />;
      case 'campaigns':
        return <CampaignsTab onOpenCampaign={setOpenCampaign} onChanged={reloadOverview} onGoToApprovals={() => goTo('approvals')} />;
      case 'audience':
        return <AudienceTab onNavigate={goTo} />;
      case 'costs':
        return <CostsTab onNavigate={goTo} />;
      case 'settings':
        return <SettingsTab onEnabledChanged={reloadOverview} />;
    }
  })();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Marketing</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          WhatsApp reminders and offers that bring customers back. Every campaign is priced before it is approved, and only customers who opted in are ever messaged.
        </p>
      </div>

      <nav aria-label="Marketing sections" className="-mx-4 overflow-x-auto px-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ul className="flex gap-1 border-b border-line">
          {MARKETING_TABS.map((t) => {
            const active = t.id === tab;
            return (
              <li key={t.id} className="shrink-0">
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => goTo(t.id)}
                  className={
                    'flex min-h-[44px] items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-tan ' +
                    (active ? 'border-tan-dark text-charcoal' : 'border-transparent text-muted hover:text-charcoal')
                  }
                >
                  {t.label}
                  {t.id === 'approvals' && pending > 0 ? (
                    <span className="rounded-full bg-tan-dark px-2 py-0.5 text-xs font-bold text-cream">
                      {pending}
                      <span className="sr-only"> waiting</span>
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div key={`${tab}:${refresh}`}>{content}</div>

      <CampaignDrawer
        id={openCampaign}
        onClose={() => setOpenCampaign(null)}
        onChanged={() => {
          reloadOverview();
          setRefresh((n) => n + 1);
        }}
      />
    </div>
  );
}
