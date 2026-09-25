// SHL-2/PRN-5 — the POS-only navigation allowlist. Phase 7 (owner request:
// "totally an isolated interface for POS") narrowed this from "any *.hioc.in
// subdomain" to the POS surface only: the app window must never be able to
// reach the customer site or the owner dashboard, even via a redirect, a
// window.open, or a lookalike host.
import { describe, expect, it } from 'vitest';
import { createOriginAllowlist, isPosNavigationAllowed } from '../../desktop/src/allowedOrigin';

describe('isPosNavigationAllowed', () => {
  const prod = { devLocalhostAllowed: false };

  it('allows the staff host, any path', () => {
    expect(isPosNavigationAllowed('https://staff.hioc.in/', prod)).toBe(true);
    expect(isPosNavigationAllowed('https://staff.hioc.in/orders', prod)).toBe(true);
    expect(isPosNavigationAllowed('https://staff.hioc.in/staff-print/1/kot', prod)).toBe(true);
    expect(isPosNavigationAllowed('https://staff.hioc.in/login?next=/orders', prod)).toBe(true);
  });

  it('allows only the POS paths on the main domain', () => {
    expect(isPosNavigationAllowed('https://hioc.in/staff', prod)).toBe(true);
    expect(isPosNavigationAllowed('https://hioc.in/staff/orders', prod)).toBe(true);
    expect(isPosNavigationAllowed('https://hioc.in/staff-print/1/kot', prod)).toBe(true);
    expect(isPosNavigationAllowed('https://hioc.in/login', prod)).toBe(true);
    expect(isPosNavigationAllowed('https://hioc.in/login?next=/staff', prod)).toBe(true);
  });

  it('blocks the customer site on the main domain', () => {
    expect(isPosNavigationAllowed('https://hioc.in/', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://hioc.in/menu', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://hioc.in/account', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://hioc.in/cart', prod)).toBe(false);
  });

  it('blocks the owner surface entirely — host and path', () => {
    expect(isPosNavigationAllowed('https://owner.hioc.in/', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://owner.hioc.in/devices', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://hioc.in/owner', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://hioc.in/owner/devices', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://hioc.in/owner/login', prod)).toBe(false);
  });

  it('blocks lookalike hosts', () => {
    expect(isPosNavigationAllowed('https://staff.hioc.in.evil.com/', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://evilhioc.in/', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://notstaff.hioc.in/', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://staff-hioc.in/', prod)).toBe(false);
  });

  it('blocks external https sites', () => {
    expect(isPosNavigationAllowed('https://evil.example.com/', prod)).toBe(false);
    expect(isPosNavigationAllowed('https://github.com/', prod)).toBe(false);
  });

  it('blocks non-TLS (http) production hosts', () => {
    expect(isPosNavigationAllowed('http://staff.hioc.in/', prod)).toBe(false);
    expect(isPosNavigationAllowed('http://hioc.in/staff', prod)).toBe(false);
  });

  it('blocks non-http(s) schemes outright', () => {
    expect(isPosNavigationAllowed('file:///etc/passwd', prod)).toBe(false);
    expect(isPosNavigationAllowed('javascript:alert(1)', prod)).toBe(false);
    expect(isPosNavigationAllowed('hioc-custom://payload', prod)).toBe(false);
  });

  it('rejects garbage URLs without throwing', () => {
    expect(isPosNavigationAllowed('not a url', prod)).toBe(false);
    expect(isPosNavigationAllowed('', prod)).toBe(false);
  });

  describe('localhost dev', () => {
    it('allows localhost:3001 only when dev mode is on', () => {
      expect(isPosNavigationAllowed('http://localhost:3001/', { devLocalhostAllowed: true })).toBe(true);
      expect(isPosNavigationAllowed('http://localhost:3001/staff/orders', { devLocalhostAllowed: true })).toBe(
        true,
      );
    });

    it('refuses localhost when the shell was NOT launched pointed at it', () => {
      expect(isPosNavigationAllowed('http://localhost:3001/', prod)).toBe(false);
    });

    it('refuses a different localhost port even in dev mode', () => {
      expect(isPosNavigationAllowed('http://localhost:3000/', { devLocalhostAllowed: true })).toBe(false);
    });

    it('refuses https on localhost', () => {
      expect(isPosNavigationAllowed('https://localhost:3001/', { devLocalhostAllowed: true })).toBe(false);
    });
  });
});

describe('createOriginAllowlist', () => {
  it('turns on the localhost dev carve-out only when HIOC_POS_URL itself points at it', () => {
    const devAllowlist = createOriginAllowlist('http://localhost:3001');
    expect(devAllowlist('http://localhost:3001/staff')).toBe(true);
    expect(devAllowlist('https://staff.hioc.in/')).toBe(true);

    const prodAllowlist = createOriginAllowlist('https://staff.hioc.in');
    expect(prodAllowlist('http://localhost:3001/staff')).toBe(false);
    expect(prodAllowlist('https://staff.hioc.in/')).toBe(true);
  });

  it('never allows localhost just because HIOC_POS_URL points at some other non-hioc host', () => {
    const allowlist = createOriginAllowlist('https://staging.example.com');
    expect(allowlist('http://localhost:3001/')).toBe(false);
  });

  it('falls back safely when HIOC_POS_URL itself is unparseable', () => {
    const allowlist = createOriginAllowlist('not a url');
    expect(allowlist('https://staff.hioc.in/')).toBe(true);
    expect(allowlist('http://localhost:3001/')).toBe(false);
  });
});
