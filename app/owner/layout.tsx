import { redirect } from 'next/navigation';
import { getOwnerUser } from '@/lib/api/auth';
import { flags } from '@/lib/flags';
import { OwnerHeader } from '@/components/owner/OwnerHeader';

// Owner surface (F3). middleware.ts already gates /owner/** to role 'owner';
// this server check via getOwnerUser() is the belt-and-suspenders second layer,
// and it also honors the dark-launch flag (XC-045).
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  if (!flags.ownerDashboard) {
    return (
      <div className="mx-auto max-w-xl px-4 py-24 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Owner dashboard coming soon</h1>
      </div>
    );
  }

  const user = await getOwnerUser();
  if (!user) redirect('/staff/login');

  return (
    <div className="min-h-screen bg-cream">
      <OwnerHeader />
      <main>{children}</main>
    </div>
  );
}
