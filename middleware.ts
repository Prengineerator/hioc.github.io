import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { surfaceForHost, rewriteForSurface } from '@/lib/routing/surface';
import { flags } from '@/lib/flags';

// PIN-2/3 — the enrolled-device cookie's name, duplicated here as a literal
// rather than imported from lib/api/deviceCookie.ts. That module pulls in
// Node's `crypto` (createHash/randomBytes) for the token itself, which this
// file must NOT import: middleware runs on the Edge runtime, where a Node
// built-in import can fail the whole build, not just this feature — the
// nightmare scenario the PIN-3 risk note (R2, "locks staff out") exists to
// avoid, applied to the one file that gates every /staff and /owner request.
// Must stay byte-identical to DEVICE_COOKIE there.
const DEVICE_COOKIE_NAME = 'hioc_device';

/**
 * Gates everything under /staff/** behind a valid Supabase session that
 * belongs to a staff profile (profiles.role === 'staff'), except
 * /staff/login itself (the only unauthenticated entry point, per spec).
 * A session alone isn't sufficient — customers authenticate through the
 * same Supabase Auth user pool, so this must also check role.
 *
 * Also forwards the current pathname as an `x-pathname` request header so
 * app/staff/layout.tsx (a Server Component, which has no direct access to
 * the URL) can tell whether it's rendering /staff/login and skip both its
 * own redundant session check and the StaffHeader chrome for that route.
 */
export async function middleware(request: NextRequest) {
  // Subdomain → canonical path, FIRST. staff.hioc.in/orders becomes
  // /staff/orders before anything below looks at the pathname, so every route,
  // layout and auth gate keeps matching the paths it already knows and none of
  // them has to learn that subdomains exist. Doing this after the gate would
  // mean staff.hioc.in/orders read as an ungated customer route.
  const surface = surfaceForHost(request.headers.get('host'));
  const rewritten = rewriteForSurface(surface, request.nextUrl.pathname);
  const pathname = rewritten ?? request.nextUrl.pathname;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', pathname);
  // Read by the root layout so links render prefix-free on a subdomain without
  // a hydration mismatch — the client must be told, not left to guess from
  // window.location after the server has already rendered.
  requestHeaders.set('x-surface', surface);

  const response = rewritten
    ? NextResponse.rewrite(new URL(rewritten + request.nextUrl.search, request.url), {
        request: { headers: requestHeaders },
      })
    : NextResponse.next({ request: { headers: requestHeaders } });

  const isStaffLogin = pathname.startsWith('/staff/login');
  const isOwnerLogin = pathname.startsWith('/owner/login');
  // Staff password reset (docs/PHASE-5-STAFF-ACCOUNTS.md, "Password emails")
  // is reached from an emailed link before the staffer has any session — it
  // needs the same unauthenticated-entry treatment as /staff/login itself.
  const isStaffResetPassword = pathname.startsWith('/staff/reset-password');
  const isLoginRoute = isStaffLogin || isOwnerLogin || isStaffResetPassword;
  const isStaffRoute = pathname.startsWith('/staff');
  const isOwnerRoute = pathname.startsWith('/owner');

  // Only /staff/** and /owner/** are gated. Each surface now has its OWN
  // unauthenticated entry point — /staff/login, /owner/login, and
  // /staff/reset-password — so all three must be excluded here or the gate
  // would redirect a login/reset page to itself.
  if ((!isStaffRoute && !isOwnerRoute) || isLoginRoute) {
    return response;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          response.cookies.set({ name, value: '', ...options });
        },
      },
    },
  );

  // Redirects to /staff/login (the shared auth entry point for both back-office
  // surfaces). Copies any cookies already queued on `response` (e.g. a session
  // token getUser() transparently refreshed) onto the redirect response —
  // building a bare `NextResponse.redirect()` would silently drop those.
  // Send people to the door for the surface they were trying to reach: an
  // expired owner session lands back on the owner login, not the counter's.
  function redirectToLogin(errorCode?: string) {
    const loginUrl = new URL(isOwnerRoute ? '/owner/login' : '/staff/login', request.url);
    loginUrl.searchParams.set('next', pathname);
    if (errorCode) {
      loginUrl.searchParams.set('error', errorCode);
    }
    const redirect = NextResponse.redirect(loginUrl);
    for (const cookie of response.cookies.getAll()) {
      redirect.cookies.set(cookie);
    }
    return redirect;
  }

  // getUser() (not getSession()) re-validates the JWT against the Supabase
  // Auth server rather than trusting an unverified cookie payload — the
  // correct check here, and it gives us the validated user id to look up
  // profiles.role with below.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // PIN-2/3: an enrolled counter with no classic session at all is the
    // NORMAL state for a machine set up for PIN operator switching (the
    // owner enrols it, then signs out — app/staff/device/page.tsx). Such a
    // request may reach the /staff/** SHELL (never /owner/**, and never with
    // the flag off) so its lock screen can render and offer a PIN. This is
    // NOT an authorization decision — merely checking a cookie is PRESENT
    // grants nothing, per D-1 (docs/SECURITY-PLAYBOOK.md): every real read or
    // write still goes through getCounterActor() at the API layer, which
    // re-verifies the device against the database and requires a further,
    // separately-issued operator cookie before it resolves to anyone.
    // app/staff/layout.tsx performs the actual "is this really an enrolled,
    // unrevoked device" check before rendering anything beyond the lock
    // screen itself.
    const hasDeviceCookie = Boolean(request.cookies.get(DEVICE_COOKIE_NAME)?.value);
    if (isStaffRoute && !isOwnerRoute && flags.pinSwitch && hasDeviceCookie) {
      return response;
    }
    return redirectToLogin();
  }

  // Customers authenticate through the same Supabase Auth user pool as
  // staff (see supabase/schema.sql's `profiles` table), so a valid session
  // alone isn't enough to grant access here — it must belong to a privileged
  // profile, or any logged-in customer could reach the back office.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    // Fails closed either way (falls through to the role-mismatch redirect
    // below), but logging this means a transient DB/network fault is
    // distinguishable from "this account genuinely isn't staff" in server
    // logs, instead of looking identical.
    console.error('middleware: profiles role lookup failed', profileError);
  }

  const role = profile?.role;
  // /owner/** is owner-only. /staff/** allows staff, manager, AND owner (all
  // have access to staff ops; manager adds refund/override powers, FND-5).
  const allowed = isOwnerRoute
    ? role === 'owner'
    : role === 'staff' || role === 'owner' || role === 'manager';

  if (!allowed) {
    // 'not_staff' tells /staff/login the session IS valid but lacks the needed
    // access, so it can show a real explanation instead of silently bouncing
    // back to a blank form after a technically-successful login.
    return redirectToLogin('not_staff');
  }

  return response;
}

export const config = {
  // Runs on EVERYTHING except Next internals and static assets.
  //
  // It used to match only /staff and /owner, which is correct for path-based
  // routing and silently wrong for subdomains: on staff.hioc.in the incoming
  // path is /orders, so middleware would never fire, no rewrite would happen,
  // and the staff portal would 404 on its own domain.
  //
  // The auth gate below still only engages for /staff and /owner paths, so the
  // added cost on a customer request is one host classification.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|images/|fonts/).*)'],
};
