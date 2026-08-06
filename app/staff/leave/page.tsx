import Link from 'next/link';
import { flags } from '@/lib/flags';
import { getStaffOrOwner } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { LeavePlanner } from '@/components/staff/LeavePlanner';

export const dynamic = 'force-dynamic';

// LEAVE-3 — weekly leave planning. Lives under /staff rather than /owner
// because MANAGERS need it and /owner/** is owner-only; a manager who could not
// reach the approval screen would make the whole workflow pointless.
//
// `canApprove` is resolved server-side and passed down. The client never
// decides its own permissions — it only decides what to render, and the API
// re-checks every write regardless.
export default async function StaffLeavePage() {
  if (!flags.attendance) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Leave planning is not enabled yet</h1>
        <Link
          href="/staff"
          className="mt-6 inline-flex rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Back to Orders
        </Link>
      </div>
    );
  }

  const account = await getStaffOrOwner();
  const canApprove = account ? await hasPermission(account.user, 'leave_approve') : false;

  return <LeavePlanner canApprove={canApprove} />;
}
