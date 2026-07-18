import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getStaffOrOwner } from '@/lib/api/auth';
import { StaffHeader } from '@/components/staff/StaffHeader';

/**
 * Nested layout for everything under /staff/**. Intentionally does NOT
 * render SiteHeader/SiteFooter or any cart UI (staff pages are a separate
 * "backstage" surface). middleware.ts is the primary auth+role gate; this
 * server-side check via getStaffUser() (session + profiles.role ===
 * 'staff') is the belt-and-suspenders second layer the spec calls for.
 * /staff/login is excluded from both this check and the StaffHeader
 * chrome, identified via the `x-pathname` header middleware forwards
 * (Server Component layouts have no direct access to the URL).
 */
export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = headers().get('x-pathname') ?? '';
  const isLoginPage = pathname.startsWith('/staff/login');

  if (isLoginPage) {
    return <>{children}</>;
  }

  const account = await getStaffOrOwner();
  if (!account) {
    redirect('/staff/login');
  }
  const { user, role } = account;
  const displayName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    '';

  return (
    <div className="min-h-screen bg-cream">
      <StaffHeader userEmail={user.email ?? ''} userName={displayName} role={role} />
      <main>{children}</main>
    </div>
  );
}
