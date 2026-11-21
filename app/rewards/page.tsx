import { redirect } from 'next/navigation';

// /rewards is kept so old links and bookmarks work; the real page is
// app/account/rewards/page.tsx. Signed-out visitors are sent to login by
// app/account/layout.tsx (next=/account/rewards).
export const dynamic = 'force-dynamic';

export default function RewardsRedirect() {
  redirect('/account/rewards');
}
