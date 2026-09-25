import { describe, expect, it } from 'vitest';
import {
  ENROLLED_NOTICE_PARAM,
  ENROLLED_NOTICE_VALUE,
  isEnrolledNotice,
  withEnrolledNotice,
} from '@/lib/staff/deviceEnrollment';

// Staff device enrolment (DEV-2) — after the owner enrols a counter from
// inside the app, the owner session is signed out immediately and the
// browser is sent back to staff sign-in with a notice explaining why. These
// two pure helpers are the one place both sides agree on the query param.

describe('withEnrolledNotice', () => {
  it('appends the notice param to a bare path', () => {
    expect(withEnrolledNotice('/staff/login')).toBe(`/staff/login?${ENROLLED_NOTICE_PARAM}=${ENROLLED_NOTICE_VALUE}`);
  });

  it('appends the notice param to the surface-shortened path too', () => {
    // hrefForSurface() on the staff subdomain shortens /staff/login to /login
    // before this runs — this must work on whatever comes out of that, not
    // just the canonical path.
    expect(withEnrolledNotice('/login')).toBe(`/login?${ENROLLED_NOTICE_PARAM}=${ENROLLED_NOTICE_VALUE}`);
  });

  it('uses & when the href already has a query string', () => {
    expect(withEnrolledNotice('/staff/login?next=/staff')).toBe(
      `/staff/login?next=/staff&${ENROLLED_NOTICE_PARAM}=${ENROLLED_NOTICE_VALUE}`,
    );
  });
});

describe('isEnrolledNotice', () => {
  it('recognises the enrolled-notice value', () => {
    expect(isEnrolledNotice(ENROLLED_NOTICE_VALUE)).toBe(true);
  });

  it('rejects anything else, including null and other notice values', () => {
    expect(isEnrolledNotice(null)).toBe(false);
    expect(isEnrolledNotice('')).toBe(false);
    expect(isEnrolledNotice('something_else')).toBe(false);
  });

  it('round-trips through withEnrolledNotice', () => {
    const href = withEnrolledNotice('/staff/login');
    const url = new URL(href, 'https://staff.hioc.in');
    expect(isEnrolledNotice(url.searchParams.get(ENROLLED_NOTICE_PARAM))).toBe(true);
  });
});
