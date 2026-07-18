import { redirect } from 'next/navigation';
import { getAuthUser } from '@/lib/api/auth';
import { AccountHeader } from '@/components/account/AccountHeader';

// Customer account surface (ACC-1..5). middleware.ts only gates /staff and
// /owner (this contract's off-limits files), so /account does its own
// server-side session check here — the single gate for everything under it.
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) {
    redirect('/login?next=/account');
  }

  return (
    <div className="min-h-screen bg-[#faf7f4]">
      <AccountHeader />
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
    </div>
  );
}
