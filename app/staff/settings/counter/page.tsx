import { getCounterActor } from '@/lib/api/auth';
import { getDeviceRegistryState } from '@/lib/api/device';
import { DeviceEnrollment } from '@/components/staff/DeviceEnrollment';
import { DesktopAppCard } from '@/components/staff/settings/DesktopAppCard';

export const dynamic = 'force-dynamic';

// DEV-2/SHL — "This counter": trusted-device enrolment. Moved here from
// /staff/device (SET-1, now a redirect to this route) as part of
// consolidating every POS/counter setting under /staff/settings; the server
// logic below is reused EXACTLY as it was on that page, comments included.
//
// Phase 7 (owner request: "more trusted and more powerful") locked the app
// window down to the staff surface only — it can no longer navigate to
// /owner/**, so /owner/devices (DeviceManager) isn't reachable from it. This
// page reuses the exact same server-side enrolment logic (app/api/owner/devices'
// POST, still owner-gated) rather than duplicating any of it: see
// DeviceEnrollment's comment for why no new API route was needed.
//
// /staff/** is already gated to a resolved actor by middleware.ts and
// app/staff/layout.tsx (getCounterActor() — PIN-3: a classic session, or an
// enrolled device's PIN operator) — this page adds no separate auth check,
// matching every other page under /staff/**.
//
// PIN-3: getCounterActor() (not getStaffOrOwner()) is load-bearing for the
// `isOwner` prop below — it caps a device-unlocked owner's role to 'manager'
// (lib/api/operator.ts), so a PIN unlock can never surface the "Sign out
// owner" escape hatch meant for a genuine classic owner session; only an
// owner who actually signed in with their password sees it.
export default async function StaffSettingsCounterPage() {
  const account = await getCounterActor();
  const registry = await getDeviceRegistryState();

  return (
    <div className="flex flex-col gap-5">
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
      <DesktopAppCard />
    </div>
  );
}
