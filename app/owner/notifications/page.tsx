// BILL-5 — owner delivery log. The layout + middleware gate /owner/** to role
// 'owner'; the API this page calls re-checks getOwnerUser() on every request.

import { NotificationLog } from '@/components/owner/NotificationLog';

export const dynamic = 'force-dynamic';

export default function OwnerNotificationsPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Notifications</h1>
        <p className="text-sm text-muted">
          Every bill and order message we tried to deliver — what reached the customer, what failed, and
          what was never attempted (and why).
        </p>
      </div>
      <NotificationLog />
    </div>
  );
}
