'use client';

// Campaigns (spec §7.4): what is being sent now, everything that has finished, and
// the "New campaign" wizard. A row opens the campaign drawer, which the dashboard
// shell owns (so a row on the Overview can open the very same drawer).

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { CampaignsResponse } from '@/lib/marketing/types';
import { API } from './api';
import { CampaignsTable } from './CampaignsTable';
import { CampaignWizard } from './CampaignWizard';
import { useApi } from './hooks';
import { Panel, ResourceGate, TabIntro } from './ui';

export function CampaignsTab({
  onOpenCampaign,
  onChanged,
  onGoToApprovals,
}: {
  onOpenCampaign: (id: string) => void;
  /** A draft was created: refresh the Approvals badge. */
  onChanged: () => void;
  onGoToApprovals: () => void;
}) {
  const active = useApi<CampaignsResponse>(API.campaigns('active'));
  const history = useApi<CampaignsResponse>(API.campaigns('history'));
  const [wizard, setWizard] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <TabIntro title="Campaigns">
          What is being sent now and what has finished. Campaigns waiting for your OK are in Approvals. Tap a row for who was in it and how it went.
        </TabIntro>
        {!wizard ? <Button onClick={() => setWizard(true)}>New campaign</Button> : null}
      </div>

      {wizard ? (
        <CampaignWizard
          onClose={() => setWizard(false)}
          onCreated={onChanged}
          onGoToApprovals={() => {
            setWizard(false);
            onGoToApprovals();
          }}
        />
      ) : null}

      <Panel title="Sending now">
        <ResourceGate resource={active} label="Loading active campaigns…">
          {(d) => (
            <CampaignsTable
              rows={d.campaigns ?? []}
              onOpen={onOpenCampaign}
              emptyMessage="Nothing is being sent right now. Approved campaigns show here while they send."
            />
          )}
        </ResourceGate>
      </Panel>

      <Panel title="History">
        <ResourceGate resource={history} label="Loading past campaigns…">
          {(d) => (
            <CampaignsTable
              rows={d.campaigns ?? []}
              onOpen={onOpenCampaign}
              emptyMessage="No finished campaigns yet. Once one completes you will see what it cost and what it brought back."
            />
          )}
        </ResourceGate>
      </Panel>
    </div>
  );
}
