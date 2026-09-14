// NET-1 — "was this punch made on the cafe's network?"
//
// WHAT THIS CAN AND CANNOT PROMISE, stated plainly, because the request was for
// a WiFi check and this is not quite one. No browser can read the WiFi SSID —
// there is no web API for it on any platform, and there is not going to be one.
// What a server CAN see is the public IP the request arrived from, which on the
// cafe's WiFi is the cafe's internet connection and on a phone's mobile data is
// the carrier's. So this answers "did this come through our connection", which
// is the useful half of the question.
//
// It composes with the geofence rather than replacing it:
//
//   spoofed GPS from home  → geofence passes,  network FAILS
//   in the cafe on 4G      → geofence passes,  network fails
//   in the cafe on WiFi    → geofence passes,  network passes
//
// It FLAGS, it does not block (owner decision, 2026-09-14) — the same posture
// as every other integrity signal in this system. The reason is concrete: most
// small-business connections have a DYNAMIC public IP that changes when the
// router reboots or the ISP renews the lease. A blocking check would lock the
// entire team out of clocking in at 7am on a morning nobody changed anything,
// and they would discover it at the door. A flag costs an owner one glance at
// the sheet; a block costs a shift.

import type { AttendanceFlag } from '@/lib/types';

export type StoreNetworkCode =
  /** No networks configured — the check is off, and silence is the right answer. */
  | 'not_configured'
  | 'on_network'
  | 'off_network'
  /** The request carried no usable client IP. Not proof of anything, so flagged. */
  | 'no_ip';

export interface StoreNetworkVerdict {
  code: StoreNetworkCode;
  /** The allowlist entry that matched, for the owner's audit line. */
  matched: string | null;
  flags: AttendanceFlag[];
}

/** Parses an IPv4 or IPv6 literal into bytes. Null if it is neither. */
export function parseIp(input: string): Uint8Array | null {
  const raw = input.trim().replace(/^\[|\]$/g, '');
  if (!raw) return null;
  if (raw.includes(':')) return parseIpv6(raw);
  return parseIpv4(raw);
}

function parseIpv4(raw: string): Uint8Array | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    // Reject '01' and '1e2' and '' — only plain decimal 0-255.
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(raw: string): Uint8Array | null {
  // An IPv4-mapped tail (::ffff:203.0.113.9) is common behind proxies.
  let head = raw;
  let tail: Uint8Array | null = null;
  const lastColon = raw.lastIndexOf(':');
  const maybeV4 = raw.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    tail = parseIpv4(maybeV4);
    if (!tail) return null;
    head = raw.slice(0, lastColon + 1) + '0:0';
  }

  const halves = head.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':'));
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  const explicit = left.length + right.length;
  if (explicit > 8) return null;
  if (halves.length === 1 && explicit !== 8) return null;

  const groups = [
    ...left,
    ...new Array(8 - explicit).fill('0'),
    ...right,
  ];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  if (tail) out.set(tail, 12);
  return out;
}

/** True when `ip` falls inside `entry`, which may be a literal or CIDR. */
export function ipMatches(ip: string, entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;

  const slash = trimmed.indexOf('/');
  const baseText = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const base = parseIp(baseText);
  const addr = parseIp(ip);
  if (!base || !addr) return false;
  // A v4 address is never inside a v6 range and vice versa.
  if (base.length !== addr.length) return false;

  if (slash === -1) {
    return base.every((byte, i) => byte === addr[i]);
  }

  const prefixText = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  const maxBits = base.length * 8;
  if (prefix > maxBits) return false;

  const wholeBytes = prefix >> 3;
  for (let i = 0; i < wholeBytes; i++) {
    if (base[i] !== addr[i]) return false;
  }
  const remainingBits = prefix & 7;
  if (remainingBits === 0) return true;
  // Compare only the leading bits of the boundary byte.
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (base[wholeBytes] & mask) === (addr[wholeBytes] & mask);
}

export function evaluateStoreNetwork(
  ip: string | null | undefined,
  allowed: readonly string[] | null | undefined,
): StoreNetworkVerdict {
  const entries = (allowed ?? []).map((e) => e.trim()).filter(Boolean);

  // Nothing configured is not a failure — it is an owner who has not set this
  // up. Flagging every punch in that state would fill the sheet with warnings
  // about a feature nobody turned on.
  if (entries.length === 0) {
    return { code: 'not_configured', matched: null, flags: [] };
  }

  const addr = (ip ?? '').trim();
  if (!addr || !parseIp(addr)) {
    // "We could not tell" is not "yes". Flagged, never blocked — and since the
    // owner reviews these, an environment that stops forwarding the client IP
    // shows up as a wave of flags rather than as silence.
    return { code: 'no_ip', matched: null, flags: ['off_network'] };
  }

  const matched = entries.find((entry) => ipMatches(addr, entry)) ?? null;
  return matched
    ? { code: 'on_network', matched, flags: [] }
    : { code: 'off_network', matched: null, flags: ['off_network'] };
}

/** Rejects junk before it reaches the settings row, so a typo cannot silently
 *  disable the check by never matching anything. */
export function isValidNetworkEntry(entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  const slash = trimmed.indexOf('/');
  const base = parseIp(slash === -1 ? trimmed : trimmed.slice(0, slash));
  if (!base) return false;
  if (slash === -1) return true;
  const prefixText = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return false;
  return Number(prefixText) <= base.length * 8;
}
