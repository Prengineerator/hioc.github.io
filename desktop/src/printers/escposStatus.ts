// PRN-4 — pure ESC/POS "DLE EOT" real-time status: build the query bytes and
// parse a printer's single-byte replies into a PrinterHealth. This file is
// deliberately dependency-free (no `electron` import, no I/O) so it runs
// identically on real hardware (network.ts, usb.ts) and in tests.
//
// Epson-compatible (TM-series and clones) bit meanings for the three queries
// this shell actually uses — n=1 printer status, n=2 offline-cause status,
// n=4 roll-paper sensor status. n=3 (error status) is not queried; offline
// cause bit 5 already tells us "an error occurred" which is enough to fail
// loudly per PRN-4.
//
//   DLE EOT 1 (printer status)   bit 3: 1 = offline
//   DLE EOT 2 (offline cause)    bit 2: 1 = cover open
//                                 bit 5: 1 = error occurred
//   DLE EOT 4 (paper sensor)     bits 2-3: 1 = near-end (either sensor)
//                                 bits 5-6: 1 = out of paper (either sensor)
//
// All other bits are fixed 0/1 markers on real hardware and are ignored here.

import type { PrinterHealth } from '@/lib/desktop/bridge';

export const DLE = 0x10;
export const EOT = 0x04;

export type StatusQueryKind = 'printer' | 'offlineCause' | 'paper';

const QUERY_N: Record<StatusQueryKind, number> = {
  printer: 1,
  offlineCause: 2,
  paper: 4,
};

/** The 3-byte "transmit real-time status" command: `DLE EOT n`. */
export function statusQuery(kind: StatusQueryKind): Uint8Array {
  return new Uint8Array([DLE, EOT, QUERY_N[kind]]);
}

/** All three queries a health check needs, in the order to send them. */
export function allStatusQueries(): { kind: StatusQueryKind; bytes: Uint8Array }[] {
  return (['printer', 'offlineCause', 'paper'] as StatusQueryKind[]).map((kind) => ({
    kind,
    bytes: statusQuery(kind),
  }));
}

function bit(byte: number, n: number): boolean {
  return (byte & (1 << n)) !== 0;
}

/** Whichever single-byte replies actually came back. A query the printer
 * never answered (network/USB timeout) is simply left `undefined` — that is
 * NOT the same as a byte of 0x00, and must not be treated as "healthy". */
export interface StatusBytes {
  printer?: number;
  offlineCause?: number;
  paper?: number;
}

export interface ParsedStatus {
  health: PrinterHealth;
  detail?: string;
}

/**
 * Priority order (most actionable/severe first): paper_out > cover_open >
 * error > offline > paper_near_end > ok. A printer with no reply to any query
 * reports 'unknown' — that's the honest answer for a connection that can't
 * read status at all (system printers) or one that never responded.
 */
export function parseStatus(bytes: StatusBytes): ParsedStatus {
  if (bytes.printer === undefined && bytes.offlineCause === undefined && bytes.paper === undefined) {
    return { health: 'unknown', detail: 'Printer did not answer the status query' };
  }

  if (bytes.paper !== undefined && (bit(bytes.paper, 5) || bit(bytes.paper, 6))) {
    return { health: 'paper_out', detail: 'Out of paper' };
  }

  if (bytes.offlineCause !== undefined && bit(bytes.offlineCause, 2)) {
    return { health: 'cover_open', detail: 'Printer cover is open' };
  }

  if (bytes.offlineCause !== undefined && bit(bytes.offlineCause, 5)) {
    return { health: 'error', detail: 'Printer reported an error' };
  }

  if (bytes.printer !== undefined && bit(bytes.printer, 3)) {
    return { health: 'offline', detail: 'Printer is offline' };
  }

  if (bytes.paper !== undefined && (bit(bytes.paper, 2) || bit(bytes.paper, 3))) {
    return { health: 'paper_near_end', detail: 'Paper is near the end of the roll' };
  }

  return { health: 'ok' };
}
