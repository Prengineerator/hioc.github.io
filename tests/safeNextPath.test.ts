import { describe, it, expect } from 'vitest';
import { safeNextPath } from '@/lib/url';

// /login?next=… is followed server-side after sign-in; anything but a
// same-site path would make it an open redirect.
describe('safeNextPath', () => {
  it('keeps same-site paths', () => {
    expect(safeNextPath('/account/orders')).toBe('/account/orders');
    expect(safeNextPath('/checkout?x=1')).toBe('/checkout?x=1');
  });
  it('refuses other hosts and tricks', () => {
    expect(safeNextPath('https://evil.com')).toBeNull();
    expect(safeNextPath('//evil.com')).toBeNull();
    expect(safeNextPath('/\\evil.com')).toBeNull();
    expect(safeNextPath('javascript:alert(1)')).toBeNull();
    expect(safeNextPath('/ok\nLocation: x')).toBeNull();
    expect(safeNextPath('')).toBeNull();
    expect(safeNextPath(null)).toBeNull();
  });
});
