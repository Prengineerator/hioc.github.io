import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getAuthUser } from '@/lib/api/auth';
import { AccountHeader } from '@/components/account/AccountHeader';

// Customer account surface (ACC-1..5). middleware.ts only gates /staff and
// /owner (this contract's off-limits files), so /account does its own
// server-side session check here — the single gate for everything under it.
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) {
    // Send them back to what they actually asked for (e.g. a "view my
    // orders" link to /account/orders) rather than always bouncing to the
    // generic /account landing page. This Server Component has no direct
    // view of the request URL, so it reads the `x-pathname` header
    // middleware.ts forwards on every request (same pattern as
    // app/staff/layout.tsx / app/owner/layout.tsx).
    const pathname = headers().get('x-pathname') || '/account';
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }

  return (
    <div className="min-h-screen bg-[#faf7f4]">
      <AccountHeader />
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
    </div>
  );
}
