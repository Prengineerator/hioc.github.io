import { describe, expect, it } from 'vitest';
import { appendSearchParams, safeNextPath } from '@/lib/url';

// SET-1 — appendSearchParams() is what the old-route redirects
// (/staff/printers → /staff/settings/printers, /staff/device →
// /staff/settings/counter) use to preserve any query string a bookmark or
// an already-open desktop-app tab arrives with.

describe('appendSearchParams', () => {
  it('returns the bare path when there is no query string', () => {
    expect(appendSearchParams('/staff/settings/printers', {})).toBe('/staff/settings/printers');
  });

  it('ignores undefined values', () => {
    expect(appendSearchParams('/staff/settings/printers', { foo: undefined })).toBe(
      '/staff/settings/printers',
    );
  });

  it('appends a single query param', () => {
    expect(appendSearchParams('/staff/settings/printers', { notice: 'counter_enrolled' })).toBe(
      '/staff/settings/printers?notice=counter_enrolled',
    );
  });

  it('appends multiple query params', () => {
    const result = appendSearchParams('/staff/settings/counter', { a: '1', b: '2' });
    // URLSearchParams preserves insertion order.
    expect(result).toBe('/staff/settings/counter?a=1&b=2');
  });

  it('repeats a key for each value of an array param', () => {
    const result = appendSearchParams('/staff/settings/printers', { tag: ['x', 'y'] });
    expect(result).toBe('/staff/settings/printers?tag=x&tag=y');
  });

  it('URL-encodes values that need it', () => {
    const result = appendSearchParams('/staff/settings/counter', { next: '/staff/settings?a=b' });
    expect(result).toBe('/staff/settings/counter?next=%2Fstaff%2Fsettings%3Fa%3Db');
  });
});

describe('safeNextPath', () => {
  it('still works alongside appendSearchParams (unchanged behaviour)', () => {
    expect(safeNextPath('/staff')).toBe('/staff');
    expect(safeNextPath('//evil.com')).toBeNull();
  });
});
