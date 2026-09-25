import { describe, expect, it } from 'vitest';
import { colsFor, edgeLine, rulerLine, testTicketDoc } from '@/lib/print/testTicket';

// PRN-3 — the Test print ticket's alignment ruler must be exactly the
// paper's column count wide, at both supported widths, so a mismatched
// "Paper width" setting shows up immediately as a wrapped or truncated line.

describe('colsFor', () => {
  it('is 48 at 80mm and 32 at 58mm — matches lib/print/escpos.ts', () => {
    expect(colsFor(80)).toBe(48);
    expect(colsFor(58)).toBe(32);
  });
});

describe('rulerLine', () => {
  it('is exactly `cols` characters wide for both paper widths', () => {
    expect(rulerLine(colsFor(80))).toHaveLength(48);
    expect(rulerLine(colsFor(58))).toHaveLength(32);
  });

  it('is the digit sequence 1234567890 repeating', () => {
    expect(rulerLine(48)).toBe('123456789012345678901234567890123456789012345678'.slice(0, 48));
    expect(rulerLine(10)).toBe('1234567890');
    expect(rulerLine(15)).toBe('123456789012345');
  });
});

describe('edgeLine', () => {
  it('is exactly `cols` characters wide, with | at both ends and spaces between', () => {
    for (const cols of [32, 48]) {
      const line = edgeLine(cols);
      expect(line).toHaveLength(cols);
      expect(line[0]).toBe('|');
      expect(line[line.length - 1]).toBe('|');
      expect(line.slice(1, -1)).toBe(' '.repeat(cols - 2));
    }
  });
});

describe('testTicketDoc', () => {
  it('includes a ruler line and an edge line at the printer\'s actual column count', () => {
    for (const width of [58, 80] as const) {
      const cols = colsFor(width);
      const doc = testTicketDoc('Kitchen', width);
      const textBlocks = doc.blocks.filter((b) => b.kind === 'text') as Extract<
        (typeof doc.blocks)[number],
        { kind: 'text' }
      >[];
      expect(textBlocks.some((b) => b.text === rulerLine(cols))).toBe(true);
      expect(textBlocks.some((b) => b.text === edgeLine(cols))).toBe(true);
      expect(textBlocks.some((b) => /paper width/i.test(b.text))).toBe(true);
    }
  });

  it('has no leading feed block — the ticket starts straight into content', () => {
    const doc = testTicketDoc('Kitchen', 80);
    expect(doc.blocks[0].kind).not.toBe('feed');
  });

  it('starts with the brandHeader placeholder, same as a real receipt/token', () => {
    const doc = testTicketDoc('Kitchen', 80);
    expect(doc.blocks[0]).toEqual({ kind: 'brandHeader' });
  });

  it('has no trailing feed block at all — renderEscPos alone owns the trailer feed', () => {
    const doc = testTicketDoc('Kitchen', 80);
    expect(doc.blocks.some((b) => b.kind === 'feed')).toBe(false);
  });
});
