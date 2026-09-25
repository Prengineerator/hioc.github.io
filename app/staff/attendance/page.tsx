import Link from 'next/link';
import { flags } from '@/lib/flags';
import { getCounterActor } from '@/lib/api/auth';
import { AttendancePunch } from '@/components/staff/AttendancePunch';
import { CashOverridePanel } from '@/components/staff/CashOverridePanel';

export const dynamic = 'force-dynamic';

// ATT-1 — the staff attendance screen. The /staff/** layout already gates this
// behind getCounterActor() (PIN-3: classic session, or an enrolled device's
// PIN operator — the operator IS the person, and their PIN proves that).
//
// Dark-launched behind the `attendance` flag, which defaults OFF and must stay
// off until the geofence has been tuned on site (Gate 5A-i). An untuned radius
// refuses honest staff, and a feature that refuses honest staff on day one does
// not get a second chance with the team.
//
// CC-3 — role is resolved server-side (same pattern as app/staff/leave/page.tsx)
// and used only to decide whether to mount CashOverridePanel at all; the client
// never decides its own permissions, and the override API re-checks regardless.
export default async function StaffAttendancePage() {
  if (!flags.attendance) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Attendance is not enabled yet</h1>
        <p className="mt-3 text-muted">
          Clock-in is still being set up for this cafe.
        </p>
        <Link
          href="/staff"
          className="mt-6 inline-flex rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Back to Orders
        </Link>
      </div>
    );
  }

  const account = await getCounterActor();
  const canManageCash = account ? account.role === 'manager' || account.role === 'owner' : false;

  return (
    <>
      <AttendancePunch />
      {canManageCash ? <CashOverridePanel /> : null}
    </>
  );
}
