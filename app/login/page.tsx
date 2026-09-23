import { redirect } from 'next/navigation';
import { getAuthUser } from '@/lib/api/auth';
import { LoginForm } from './LoginForm';
import { safeNextPath } from '@/lib/url';

// Customer login (ACC-1). A Server Component so an already-signed-in
// visitor — including a phone-only account (see components/site/AccountNav
// and app/api/auth/me) — never sees the login form at all: redirected
// server-side, before any client JS runs, instead of the form flashing
// first and only bouncing once a client-side session check resolves.
//
// Reads `searchParams` directly (a plain prop on a Server Component page)
// rather than the client-side useSearchParams() hook the form used to rely
// on just for this — which also means LoginForm needs no Suspense boundary
// anymore.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string | string[] };
}) {
  const rawNext = searchParams.next;
  const candidate =
    typeof rawNext === 'string' && rawNext.length > 0
      ? rawNext
      : Array.isArray(rawNext) && rawNext.length > 0
        ? rawNext[0]
        : null;
  // Only same-site paths: "?next=https://evil.com" or "//evil.com" would turn
  // the login page into an open redirect for phishing links.
  const next = safeNextPath(candidate);

  const user = await getAuthUser();
  if (user) {
    // Already logged in — go straight to what `next` asked for (e.g.
    // /account/orders from the account gate, /rewards from the rewards
    // page), or /account when nothing specific was asked for.
    redirect(next ?? '/account');
  }

  return <LoginForm initialNext={next} />;
}
