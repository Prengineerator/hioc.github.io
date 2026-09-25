import { getStaffOrOwner } from '@/lib/api/auth';
import { getDeviceRegistryState } from '@/lib/api/device';
import { DeviceEnrollment } from '@/components/staff/DeviceEnrollment';

export const dynamic = 'force-dynamic';

// DEV-2/SHL — "This counter": trusted-device enrolment, reached from INSIDE
// the desktop app. Phase 7 (owner request: "more trusted and more powerful")
// locked the app window down to the staff surface only — it can no longer
// navigate to /owner/**, so /owner/devices (DeviceManager) isn't reachable
// from it. This page reuses the exact same server-side enrolment logic
// (app/api/owner/devices' POST, still owner-gated) rather than duplicating
// any of it: see DeviceEnrollment's comment for why no new API route was
// needed.
//
// /staff/** is already gated to a signed-in staff/owner/manager session by
// middleware.ts and app/staff/layout.tsx (getStaffOrOwner()) — this page adds
// no separate check, matching every other page under /staff/**.
export default async function StaffDevicePage() {
  const account = await getStaffOrOwner();
  const registry = await getDeviceRegistryState();

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">This counter</h1>
        <p className="text-sm text-muted">
          Enrolling this machine tells HIOC it&apos;s a known, trusted counter — a fact about the machine,
          not a login.
        </p>
      </div>
      <DeviceEnrollment
        isOwner={account?.role === 'owner'}
        registryAvailable={registry.available}
        device={
          registry.device
            ? { name: registry.device.name, enrolled_at: registry.device.enrolled_at }
            : null
        }
      />
    </div>
  );
}
