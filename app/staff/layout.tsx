import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getStaffUser } from '@/lib/api/auth';
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

  const user = await getStaffUser();
  if (!user) {
    redirect('/staff/login');
  }

  return (
    <div className="min-h-screen bg-cream">
      <StaffHeader />
      <main>{children}</main>
    </div>
  );
}
