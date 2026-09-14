import { describe, expect, it } from 'vitest';
import {
  evaluateStoreNetwork,
  ipMatches,
  isValidNetworkEntry,
  parseIp,
} from '@/lib/attendance/network';

// NET-1 — "did this punch come through the cafe's connection?"
//
// Every wrong answer here is a wrong answer on someone's attendance record, and
// the two failure directions are not symmetric: a false "off network" nags an
// honest staffer every single day until someone works out why, which is how a
// team stops trusting the whole system.

describe('parseIp', () => {
  it('reads IPv4', () => {
    expect(Array.from(parseIp('49.36.12.34')!)).toEqual([49, 36, 12, 34]);
  });

  it('rejects things that merely look like IPv4', () => {
    for (const bad of ['49.36.12', '49.36.12.256', '49.36.12.34.5', '1e2.0.0.1', '', '..']) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it('reads IPv6, including compressed and IPv4-mapped forms', () => {
    expect(parseIp('::1')).not.toBeNull();
    expect(parseIp('2405:201:1234:5678:90ab:cdef:1234:5678')).not.toBeNull();
    // Proxies routinely present a v4 client this way.
    expect(Array.from(parseIp('::ffff:203.0.113.9')!).slice(12)).toEqual([203, 0, 113, 9]);
  });

  it('strips the brackets a v6 literal may arrive in', () => {
    expect(parseIp('[2405:201::1]')).not.toBeNull();
  });

  it('rejects malformed IPv6', () => {
    for (const bad of ['1::2::3', 'gggg::1', '2405:201:1234:5678:90ab:cdef:1234']) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });
});

describe('ipMatches', () => {
  it('matches a literal address exactly', () => {
    expect(ipMatches('49.36.12.34', '49.36.12.34')).toBe(true);
    expect(ipMatches('49.36.12.35', '49.36.12.34')).toBe(false);
  });

  it('matches inside an IPv4 CIDR range', () => {
    // The realistic case: an ISP that moves a small business around a pool.
    expect(ipMatches('49.36.12.1', '49.36.12.0/24')).toBe(true);
    expect(ipMatches('49.36.12.255', '49.36.12.0/24')).toBe(true);
    expect(ipMatches('49.36.13.1', '49.36.12.0/24')).toBe(false);
  });

  it('handles a prefix that does not land on a byte boundary', () => {
    // /25 splits the last byte — the case an implementation that only compares
    // whole bytes gets silently wrong, and it would admit twice the range.
    expect(ipMatches('49.36.12.127', '49.36.12.0/25')).toBe(true);
    expect(ipMatches('49.36.12.128', '49.36.12.0/25')).toBe(false);
    expect(ipMatches('10.0.0.1', '10.0.0.0/7')).toBe(true);
    expect(ipMatches('12.0.0.1', '10.0.0.0/7')).toBe(false);
  });

  it('matches an IPv6 prefix', () => {
    // A v6 connection gives each device its own address inside one prefix, so
    // exact matching would fail for every phone but the one that was added.
    expect(ipMatches('2405:201:1234:abcd::9', '2405:201:1234::/48')).toBe(true);
    expect(ipMatches('2405:201:9999:abcd::9', '2405:201:1234::/48')).toBe(false);
  });

  it('never matches across address families', () => {
    expect(ipMatches('49.36.12.34', '::/0')).toBe(false);
    expect(ipMatches('2405:201::1', '0.0.0.0/0')).toBe(false);
  });

  it('refuses a nonsense entry rather than matching everything', () => {
    expect(ipMatches('49.36.12.34', 'the cafe wifi')).toBe(false);
    expect(ipMatches('49.36.12.34', '49.36.12.0/33')).toBe(false);
    expect(ipMatches('49.36.12.34', '')).toBe(false);
  });
});

describe('evaluateStoreNetwork', () => {
  it('says nothing at all when no networks are configured', () => {
    // Empty means OFF, not "refuse everything". An owner who has not set this
    // up must not get a sheet full of warnings about a feature they never
    // turned on.
    expect(evaluateStoreNetwork('49.36.12.34', [])).toEqual({
      code: 'not_configured',
      matched: null,
      flags: [],
    });
    expect(evaluateStoreNetwork(null, null).flags).toEqual([]);
  });

  it('passes a punch from the cafe, clean', () => {
    const v = evaluateStoreNetwork('49.36.12.34', ['49.36.12.0/24']);
    expect(v.code).toBe('on_network');
    expect(v.matched).toBe('49.36.12.0/24');
    expect(v.flags).toEqual([]);
  });

  it('flags a punch from somewhere else', () => {
    // Mobile data in the cafe, or a spoofed GPS from home — the geofence cannot
    // tell those apart from the real thing, and this can.
    const v = evaluateStoreNetwork('182.70.1.1', ['49.36.12.0/24']);
    expect(v.code).toBe('off_network');
    expect(v.flags).toEqual(['off_network']);
  });

  it('flags — never trusts — a request with no usable IP', () => {
    // "We could not tell" is not "yes". It is also how a proxy that stops
    // forwarding the client IP becomes visible, as a wave of flags rather than
    // as silence.
    for (const ip of [null, undefined, '', 'unknown']) {
      expect(evaluateStoreNetwork(ip, ['49.36.12.0/24']).code).toBe('no_ip');
      expect(evaluateStoreNetwork(ip, ['49.36.12.0/24']).flags).toEqual(['off_network']);
    }
  });

  it('accepts a match on any one of several networks', () => {
    const v = evaluateStoreNetwork('182.70.1.1', ['49.36.12.0/24', '182.70.1.1']);
    expect(v.code).toBe('on_network');
    expect(v.matched).toBe('182.70.1.1');
  });

  it('ignores blank entries without treating the list as empty', () => {
    const v = evaluateStoreNetwork('182.70.1.1', ['  ', '49.36.12.0/24']);
    expect(v.code).toBe('off_network');
  });
});

describe('isValidNetworkEntry', () => {
  it('accepts addresses and ranges', () => {
    for (const good of ['49.36.12.34', '49.36.12.0/24', '2405:201:1234::/48', '::1']) {
      expect(isValidNetworkEntry(good), good).toBe(true);
    }
  });

  it('rejects what the owner might type by mistake', () => {
    // A stored typo can never match, which would turn every honest punch into a
    // flag — so it is refused at the settings screen instead.
    for (const bad of ['', 'HIOC-WiFi', '49.36.12', '49.36.12.0/99', '49.36.12.0/abc']) {
      expect(isValidNetworkEntry(bad), bad).toBe(false);
    }
  });
});
