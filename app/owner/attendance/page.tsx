import Link from 'next/link';
import { flags } from '@/lib/flags';
import { AttendanceSheet } from '@/components/owner/AttendanceSheet';

// SHEET-1 — the owner attendance sheet. /owner/** is already gated to role
// 'owner' by middleware and the layout; the API additionally allows a manager
// through `attendance_approve` (D5-8), which is the gate that actually matters
// since it is where the data lives.
export default function OwnerAttendancePage() {
  if (!flags.attendance) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Attendance is not enabled yet</h1>
        <p className="mt-3 text-muted">
          Set the cafe location in Settings and turn on the attendance flag to start recording
          shifts.
        </p>
        <Link
          href="/owner/settings"
          className="mt-6 inline-flex rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Go to Settings
        </Link>
      </div>
    );
  }

  return <AttendanceSheet />;
}
