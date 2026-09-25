// Staff — pure helper shared between components/staff/DeviceEnrollment.tsx
// and app/staff/login/page.tsx. Kept out of the client component so it's
// unit-testable without React/DOM, and shared (not two separate magic
// strings) so the redirect and the banner it triggers can never drift apart.
//
// Why this exists: enrolling a counter from inside the app requires signing
// in as the owner right there (lib/auth/audience.ts blocks that on the
// ordinary /staff/login form) — see DeviceEnrollment's file comment. That
// owner session must never be left signed in on the shared counter machine
// afterwards (owner-authority /api/owner/* calls would keep working from
// this screen, and orders/settles would attribute to the owner instead of
// whichever staffer is actually at the till). So every path that leaves an
// owner session on this screen ends it and sends the browser back to
// /staff/login, with this query param telling that page to explain why.

export const ENROLLED_NOTICE_PARAM = 'notice';
export const ENROLLED_NOTICE_VALUE = 'counter_enrolled';

/**
 * Appends the "just enrolled" notice to an ALREADY surface-resolved
 * staff-login href (pass it useSurfaceHref()('/staff/login'), not the
 * canonical path) — pure string work only, so it can't duplicate or diverge
 * from hrefForSurface()'s own handling of the path/host split.
 */
export function withEnrolledNotice(staffLoginHref: string): string {
  const separator = staffLoginHref.includes('?') ? '&' : '?';
  return `${staffLoginHref}${separator}${ENROLLED_NOTICE_PARAM}=${ENROLLED_NOTICE_VALUE}`;
}

/** True when a staff-login URL's `notice` search param is the "just
 * enrolled" one — the one place both sides agree on what the param means. */
export function isEnrolledNotice(noticeParam: string | null): boolean {
  return noticeParam === ENROLLED_NOTICE_VALUE;
}
