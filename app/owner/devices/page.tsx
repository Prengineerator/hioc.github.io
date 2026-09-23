// Owner-only device registry (DEV-2/DEV-3). The owner layout + middleware gate
// /owner/** to role 'owner'; /api/owner/devices re-checks getOwnerUser() on
// every request. Enrolling always enrolls the machine you are sitting at —
// there is no way to hand a secret to a machine that isn't here.

import { DeviceManager } from '@/components/owner/DeviceManager';

export const dynamic = 'force-dynamic';

export default function OwnerDevicesPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Devices</h1>
        <p className="text-sm text-muted">
          Name the machines that take orders — the counter till, the back office, an event stand — so each
          can have its own printing and order-type defaults, and so you can cut one off if it leaves.
        </p>
      </div>
      <DeviceManager />
    </div>
  );
}
