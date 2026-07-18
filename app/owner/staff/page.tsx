// Owner-only Team management (add/remove staff & managers without SQL). The
// owner layout + middleware already gate /owner/** to role 'owner'; the API this
// page calls re-checks getOwnerUser() on every request.

import { TeamManager } from '@/components/owner/TeamManager';

export const dynamic = 'force-dynamic';

export default function OwnerStaffPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Team</h1>
        <p className="text-sm text-muted">Grant or revoke staff-board access for the counter team.</p>
      </div>
      <TeamManager />
    </div>
  );
}
