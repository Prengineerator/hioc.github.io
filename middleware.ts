import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

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
  const pathname = request.nextUrl.pathname;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', pathname);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const isLoginRoute = pathname.startsWith('/staff/login');
  const isStaffRoute = pathname.startsWith('/staff');

  if (!isStaffRoute || isLoginRoute) {
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

  // Redirects to /staff/login. Copies any cookies already queued on
  // `response` (e.g. a session token getUser() transparently refreshed)
  // onto the redirect response — building a bare `NextResponse.redirect()`
  // instead would silently drop those.
  function redirectToLogin(errorCode?: string) {
    const loginUrl = new URL('/staff/login', request.url);
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
    return redirectToLogin();
  }

  // Customers authenticate through the same Supabase Auth user pool as
  // staff (see supabase/schema.sql's `profiles` table), so a valid session
  // alone isn't enough to grant access here — it must belong to a staff
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

  if (profile?.role !== 'staff') {
    // 'not_staff' tells /staff/login the session IS valid but lacks staff
    // access, so it can show a real explanation instead of silently
    // bouncing back to a blank form after a technically-successful login.
    return redirectToLogin('not_staff');
  }

  return response;
}

export const config = {
  matcher: ['/staff', '/staff/:path*'],
};
