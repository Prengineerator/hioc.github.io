// PRN-4 — golden-byte and bit-decoding tests for the pure DLE EOT status
// helper. Imported by relative path (not the `@/` alias) since it lives
// outside the `desktop/` TypeScript project that owns that alias mapping.
import { describe, expect, it } from 'vitest';
import { allStatusQueries, parseStatus, statusQuery } from '../../desktop/src/printers/escposStatus';

describe('statusQuery', () => {
  it('builds DLE EOT 1 for the printer status query', () => {
    expect(Array.from(statusQuery('printer'))).toEqual([0x10, 0x04, 0x01]);
  });

  it('builds DLE EOT 2 for the offline-cause query', () => {
    expect(Array.from(statusQuery('offlineCause'))).toEqual([0x10, 0x04, 0x02]);
  });

  it('builds DLE EOT 4 for the paper-sensor query', () => {
    expect(Array.from(statusQuery('paper'))).toEqual([0x10, 0x04, 0x04]);
  });
});

describe('allStatusQueries', () => {
  it('returns all three queries in a stable order', () => {
    const queries = allStatusQueries();
    expect(queries.map((q) => q.kind)).toEqual(['printer', 'offlineCause', 'paper']);
    expect(queries.map((q) => Array.from(q.bytes))).toEqual([
      [0x10, 0x04, 0x01],
      [0x10, 0x04, 0x02],
      [0x10, 0x04, 0x04],
    ]);
  });
});

describe('parseStatus', () => {
  it('reports unknown when nothing answered', () => {
    expect(parseStatus({})).toEqual({
      health: 'unknown',
      detail: 'Printer did not answer the status query',
    });
  });

  it('reports ok when only fixed/marker bits are set', () => {
    // bit0 fixed 0, bit1 fixed 1 on real hardware for all three replies.
    expect(parseStatus({ printer: 0b0000_0010, offlineCause: 0b0000_0010, paper: 0b0000_0010 })).toEqual({
      health: 'ok',
    });
  });

  it('detects paper-out from bit 5 of the paper status', () => {
    expect(parseStatus({ paper: 1 << 5 })).toEqual({ health: 'paper_out', detail: 'Out of paper' });
  });

  it('detects paper-out from bit 6 of the paper status', () => {
    expect(parseStatus({ paper: 1 << 6 })).toEqual({ health: 'paper_out', detail: 'Out of paper' });
  });

  it('detects paper-near-end from bit 2 of the paper status', () => {
    expect(parseStatus({ paper: 1 << 2 })).toEqual({
      health: 'paper_near_end',
      detail: 'Paper is near the end of the roll',
    });
  });

  it('detects paper-near-end from bit 3 of the paper status', () => {
    expect(parseStatus({ paper: 1 << 3 })).toEqual({
      health: 'paper_near_end',
      detail: 'Paper is near the end of the roll',
    });
  });

  it('detects cover-open from bit 2 of the offline-cause status', () => {
    expect(parseStatus({ offlineCause: 1 << 2 })).toEqual({
      health: 'cover_open',
      detail: 'Printer cover is open',
    });
  });

  it('detects a reported error from bit 5 of the offline-cause status', () => {
    expect(parseStatus({ offlineCause: 1 << 5 })).toEqual({
      health: 'error',
      detail: 'Printer reported an error',
    });
  });

  it('detects offline from bit 3 of the printer status', () => {
    expect(parseStatus({ printer: 1 << 3 })).toEqual({ health: 'offline', detail: 'Printer is offline' });
  });

  it('prioritises paper-out over cover-open and offline when several bits fire at once', () => {
    const result = parseStatus({
      printer: 1 << 3, // offline
      offlineCause: 1 << 2, // cover open
      paper: 1 << 5, // paper out
    });
    expect(result.health).toBe('paper_out');
  });

  it('prioritises cover-open over a plain offline reading', () => {
    const result = parseStatus({
      printer: 1 << 3, // offline
      offlineCause: 1 << 2, // cover open
    });
    expect(result.health).toBe('cover_open');
  });

  it('falls back to whatever replies did arrive when one query timed out', () => {
    // Only the paper query answered; printer/offlineCause are undefined, not 0.
    expect(parseStatus({ paper: 1 << 5 })).toEqual({ health: 'paper_out', detail: 'Out of paper' });
  });
});
