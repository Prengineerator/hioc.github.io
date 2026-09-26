import { KotCountersSettings } from '@/components/staff/settings/KotCountersSettings';

// KOT counters — which counter prepares which menu categories, so the KOT
// prints as one slip per counter (lib/print/kotRouting.ts). The
// /staff/settings/** layout already gates this behind getCounterActor(); the
// manager/owner split for SAVING is enforced by PUT /api/pos/kot-routing.
export default function StaffSettingsKotCountersPage() {
  return <KotCountersSettings />;
}
