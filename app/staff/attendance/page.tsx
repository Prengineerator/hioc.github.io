import Link from 'next/link';
import { flags } from '@/lib/flags';
import { AttendancePunch } from '@/components/staff/AttendancePunch';

// ATT-1 — the staff attendance screen. The /staff/** layout already gates this
// behind getStaffOrOwner(), so a signed-in staff/manager/owner is guaranteed.
//
// Dark-launched behind the `attendance` flag, which defaults OFF and must stay
// off until the geofence has been tuned on site (Gate 5A-i). An untuned radius
// refuses honest staff, and a feature that refuses honest staff on day one does
// not get a second chance with the team.
export default function StaffAttendancePage() {
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

  return <AttendancePunch />;
}
