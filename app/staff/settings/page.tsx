import { getDeviceRegistryState } from '@/lib/api/device';
import { SettingsOverview } from '@/components/staff/settings/SettingsOverview';

export const dynamic = 'force-dynamic';

// SET-1 — the settings landing page: one card per section with a live
// status summary and a link, per the owner's request to consolidate every
// POS/counter setting under one area. Device-enrolment status is resolved
// server-side (same call app/staff/settings/counter/page.tsx makes) since
// it's cheap and already gated by /staff/**'s auth; printer and store status
// come from the desktop bridge / a client-side fetch respectively — both
// best-effort, so SettingsOverview never blocks on them.
export default async function StaffSettingsOverviewPage() {
  const registry = await getDeviceRegistryState();

  return (
    <SettingsOverview
      device={registry.available && registry.device ? { name: registry.device.name } : null}
    />
  );
}
