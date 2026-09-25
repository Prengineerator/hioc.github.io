import { describe, expect, it } from 'vitest';
import { renderEscPos, transliterate, wrapText, layoutColumns } from '@/lib/print/escpos';
import type { TicketDoc, TicketColumn } from '@/lib/print/ticketDoc';

// PRN-3 — pure byte-level tests for the ESC/POS renderer. No printer, no I/O:
// every assertion is on the Uint8Array (or the plain string helpers) the
// renderer produces.

function doc(blocks: TicketDoc['blocks']): TicketDoc {
  return { type: 'receipt', orderId: 'order-1', blocks };
}

// Finds every start index where `needle` occurs in `haystack`.
function findAll(haystack: Uint8Array, needle: number[]): number[] {
  const hits: number[] = [];
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

// Decodes the printable-text lines out of a rendered byte stream by skipping
// every known ESC/GS command (rather than crudely dropping "non-printable"
// bytes, which would leave stray characters behind for commands whose
// parameter byte happens to be printable, e.g. ESC d 0x64 ('d')).
function decodeLines(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let current = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x0a) {
      lines.push(current);
      current = '';
      i++;
      continue;
    }
    if (b === 0x1b) {
      const cmd = bytes[i + 1];
      if (cmd === 0x40) {
        i += 2; // ESC @
      } else {
        i += 3; // ESC a n / ESC E n / ESC d n
      }
      continue;
    }
    if (b === 0x1d) {
      const cmd = bytes[i + 1];
      if (cmd === 0x21) {
        i += 3; // GS ! n
      } else if (cmd === 0x56) {
        i += 4; // GS V m n
      } else if (cmd === 0x28) {
        const pL = bytes[i + 3];
        const pH = bytes[i + 4];
        i += 5 + pL + pH * 256; // GS ( k ... variable-length frame
      } else {
        i += 2;
      }
      continue;
    }
    current += String.fromCharCode(b);
    i++;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

describe('renderEscPos — init and cut', () => {
  it('starts with ESC @ (init)', () => {
    const bytes = renderEscPos(doc([{ kind: 'text', text: 'hi' }]), { paperWidthMm: 80, cut: false });
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
  });

  it('emits no feed command right after ESC @ — nothing wastes paper at the top of a ticket', () => {
    const bytes = renderEscPos(doc([{ kind: 'text', text: 'hi' }]), { paperWidthMm: 80, cut: true });
    // Byte 2 (right after the 2-byte ESC @) must not start an ESC d (0x1b 0x64) feed.
    expect(bytes[2]).not.toBe(0x1b);
  });

  it('includes the standard partial-cut command (GS V 66 0) only when cut is requested, with no cutMode set', () => {
    const cutBytes = renderEscPos(doc([{ kind: 'text', text: 'hi' }]), { paperWidthMm: 80, cut: true });
    const noCutBytes = renderEscPos(doc([{ kind: 'text', text: 'hi' }]), { paperWidthMm: 80, cut: false });
    // GS V 66 0
    expect(findAll(cutBytes, [0x1d, 0x56, 0x42, 0x00])).toHaveLength(1);
    expect(findAll(noCutBytes, [0x1d, 0x56, 0x42, 0x00])).toHaveLength(0);
  });

  it('cut: false trailer is exactly the tear-off feed (ESC d 4), no cut command at all', () => {
    const bytes = renderEscPos(doc([{ kind: 'text', text: 'hi' }]), { paperWidthMm: 80, cut: false });
    expect(Array.from(bytes.slice(-3))).toEqual([0x1b, 0x64, 0x04]);
  });
});

describe('renderEscPos — cutMode trailer bytes', () => {
  // Golden trailer bytes for each cutMode, and old configs with no cutMode
  // set at all (undefined) — the exact contract this feature must not regress.
  const cases: Array<{ cutMode: 'standard' | 'partial' | 'full' | 'legacy' | undefined; trailer: number[] }> = [
    // standard: GS V 66 0, no preceding feed — function B feeds itself.
    { cutMode: 'standard', trailer: [0x1d, 0x56, 0x42, 0x00] },
    // undefined (old saved config, pre-cutMode) renders identically to 'standard'.
    { cutMode: undefined, trailer: [0x1d, 0x56, 0x42, 0x00] },
    // partial: feed to the cutter (ESC d 4), then GS V 1.
    { cutMode: 'partial', trailer: [0x1b, 0x64, 0x04, 0x1d, 0x56, 0x01] },
    // full: feed to the cutter (ESC d 4), then GS V 0.
    { cutMode: 'full', trailer: [0x1b, 0x64, 0x04, 0x1d, 0x56, 0x00] },
    // legacy: feed to the cutter (ESC d 4), then ESC i.
    { cutMode: 'legacy', trailer: [0x1b, 0x64, 0x04, 0x1b, 0x69] },
  ];

  for (const { cutMode, trailer } of cases) {
    it(`cutMode=${cutMode ?? '(unset)'} ends with exactly ${JSON.stringify(trailer)}`, () => {
      const bytes = renderEscPos(doc([{ kind: 'text', text: 'hi' }]), { paperWidthMm: 80, cut: true, cutMode });
      expect(Array.from(bytes.slice(-trailer.length))).toEqual(trailer);
    });
  }

  it('never double-feeds: standard cutMode has exactly one ESC d in the whole trailer region', () => {
    const bytes = renderEscPos(doc([{ kind: 'text', text: 'hi' }]), {
      paperWidthMm: 80,
      cut: true,
      cutMode: 'standard',
    });
    // The trailer is everything after the last text line's \n — no ESC d (feed)
    // anywhere in it, since GS V 66 0 feeds to the cutter on its own.
    const lastNewline = bytes.lastIndexOf(0x0a);
    const trailerBytes = bytes.slice(lastNewline + 1);
    expect(findAll(trailerBytes, [0x1b, 0x64])).toHaveLength(0);
  });

  it('a printer with cut: false never receives any cut command, regardless of cutMode', () => {
    for (const cutMode of ['standard', 'partial', 'full', 'legacy'] as const) {
      const bytes = renderEscPos(doc([{ kind: 'text', text: 'hi' }]), { paperWidthMm: 80, cut: false, cutMode });
      expect(findAll(bytes, [0x1d, 0x56])).toHaveLength(0); // no GS V (any function)
      expect(findAll(bytes, [0x1b, 0x69])).toHaveLength(0); // no ESC i
    }
  });
});

describe('wrapText', () => {
  it('never returns a line longer than the requested width, at 32 and 48 columns', () => {
    const long =
      'This is a very long line of ticket text that will definitely need to wrap across several lines of receipt paper without ever exceeding the column width, even with a supercalifragilisticexpialidocioussupercalifragilistic word in it.';
    for (const width of [32, 48]) {
      const lines = wrapText(long, width);
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  it('hard-breaks a single token with no spaces longer than the column', () => {
    const lines = wrapText('a'.repeat(100), 32);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
    expect(lines.join('')).toBe('a'.repeat(100));
  });
});

// The receipt item table's real column spec (lib/print/ticketModel.ts
// itemColumns) — reused here so these tests pin the actual drop/no-drop
// behavior at 48 vs 32 cols, not just a synthetic example.
function receiptItemColumns(no: string, name: string, qty: string, price: string, amount: string): TicketColumn[] {
  return [
    { text: no, weight: 2, align: 'left', minWidth: 3 },
    { text: name, weight: 18, align: 'left', minWidth: 14 },
    { text: qty, weight: 4, align: 'right', minWidth: 4 },
    { text: price, weight: 7, align: 'right', minWidth: 6, optional: true },
    { text: amount, weight: 7, align: 'right', minWidth: 6 },
  ];
}

describe('layoutColumns', () => {
  it('every returned line is exactly totalCols characters wide, at both 32 and 48', () => {
    for (const cols of [32, 48]) {
      const lines = layoutColumns(receiptItemColumns('1', 'Cold Coffee', '2', '120.00', '240.00'), cols);
      for (const line of lines) {
        expect(line.length).toBe(cols);
      }
    }
  });

  it('right-aligns a numeric column flush against its own column boundary', () => {
    const lines = layoutColumns(
      [
        { text: 'Item', weight: 3, align: 'left', minWidth: 4 },
        { text: '240.00', weight: 1, align: 'right', minWidth: 6 },
      ],
      20,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('240.00')).toBe(true);
    expect(lines[0].startsWith('Item')).toBe(true);
  });

  it('wraps a long item name within its own column instead of overflowing into the next one', () => {
    const longName = 'Hazelnut Hot Chocolate with Extra Whipped Cream (Large)';
    const lines = layoutColumns(receiptItemColumns('1', longName, '1', '290.00', '290.00'), 48);
    expect(lines.length).toBeGreaterThan(1);
    // Every line stays exactly 48 wide (padded), and the qty/price/amount
    // values only ever appear on the FIRST wrapped line — later lines are
    // blank in those columns, not repeated or corrupted.
    for (const line of lines) {
      expect(line.length).toBe(48);
    }
    expect(lines[0]).toContain('290.00');
    expect(lines[1]).not.toContain('290.00');
    // No word from the long name is truncated mid-token across the wrap —
    // rejoining the item column's own text across lines reproduces it.
    // (No. is 3 chars + 1 gap = column 4; Item is 19 wide at 48 cols here.)
    const rejoined = lines
      .map((l) => l.slice(4, 23).trimEnd())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    for (const word of longName.split(' ')) {
      expect(rejoined).toContain(word);
    }
  });

  it('drops the optional Price column at 32 cols when the others do not leave it room, but keeps it at 48', () => {
    const cells = ['1', 'Hazelnut Hot Chocolate', '1', '290.00', '290.00'] as const;
    const at48 = layoutColumns(receiptItemColumns(...cells), 48);
    const at32 = layoutColumns(receiptItemColumns(...cells), 32);

    // 48 cols: every cell's text appears somewhere (Price survives).
    expect(at48.join('\n')).toContain('290.00');
    expect(at48.join('\n').match(/290\.00/g)?.length).toBe(2); // price AND amount both "290.00"

    // 32 cols: Price is dropped, so "290.00" (shared by price+amount in this
    // fixture) appears only once now — from Amount alone.
    expect(at32.join('\n').match(/290\.00/g)?.length).toBe(1);
  });

  it('never drops a non-optional column, even when nothing fits comfortably', () => {
    const lines = layoutColumns(receiptItemColumns('1', 'X', '1', '9.00', '9.00'), 32);
    const joined = lines.join('\n');
    expect(joined).toContain('1'); // No. and Qty.
    expect(joined).toContain('X'); // Item
    expect(joined).toContain('9.00'); // Amount
  });

  it('returns an empty array for an empty column list', () => {
    expect(layoutColumns([], 48)).toEqual([]);
  });
});

describe('renderEscPos — columns block', () => {
  it('emits one line per wrapped row, padded to the full column width', () => {
    const bytes = renderEscPos(
      doc([
        {
          kind: 'columns',
          columns: [
            { text: 'No.', weight: 2, align: 'left', minWidth: 2 },
            { text: 'Item', weight: 10, align: 'left', minWidth: 8 },
            { text: 'Amount', weight: 5, align: 'right', minWidth: 6 },
          ],
          bold: true,
        },
      ]),
      { paperWidthMm: 80, cut: false },
    );
    const lines = decodeLines(bytes).filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBe(48);
    expect(lines[0].startsWith('No.')).toBe(true);
    expect(lines[0].trimEnd().endsWith('Amount')).toBe(true);
    // bold is toggled on for the block.
    expect(findAll(bytes, [0x1b, 0x45, 0x01]).length).toBeGreaterThan(0);
  });
});

describe('renderEscPos — text block hanging indent', () => {
  it('indents a single short line by the requested number of columns', () => {
    const bytes = renderEscPos(doc([{ kind: 'text', text: 'Milk: Oat', indent: 4 }]), {
      paperWidthMm: 80,
      cut: false,
    });
    const lines = decodeLines(bytes).filter((l) => l.length > 0);
    expect(lines).toEqual(['    Milk: Oat']);
  });

  it('applies the SAME indent to every wrapped continuation line, not just the first (the actual bug report: "40.00)" wrapped to column 0)', () => {
    const longAddon =
      'Choose Extra Toppings: Chocolate Sauce, Caramel Drizzle, Whipped Cream, Sprinkles - 1x40 = 40';
    const bytes = renderEscPos(doc([{ kind: 'text', text: longAddon, indent: 4 }]), {
      paperWidthMm: 58, // 32 cols — narrow enough to force a wrap
      cut: false,
    });
    const lines = decodeLines(bytes).filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith('    ')).toBe(true); // every line, not just the first
      expect(line.length).toBeLessThanOrEqual(32);
    }
  });

  it('shrinks the wrap width by the indent so an indented line never exceeds cols', () => {
    const bytes = renderEscPos(
      doc([{ kind: 'text', text: 'a'.repeat(40), indent: 4 }]),
      { paperWidthMm: 58, cut: false }, // 32 cols
    );
    const lines = decodeLines(bytes).filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
    // The indent (4 spaces) is real: every line's non-indent content is at
    // most 32 - 4 = 28 characters.
    for (const line of lines) {
      expect(line.slice(4).length).toBeLessThanOrEqual(28);
    }
  });

  it('ignores indent on a centered/right-aligned block — alignment already positions the whole line', () => {
    const bytes = renderEscPos(doc([{ kind: 'text', text: 'HIOC.', align: 'center', indent: 4 }]), {
      paperWidthMm: 80,
      cut: false,
    });
    const lines = decodeLines(bytes).filter((l) => l.length > 0);
    expect(lines).toEqual(['HIOC.']); // no leading spaces baked into the text itself
  });

  it('defaults to no indent when omitted — unchanged from before this feature', () => {
    const bytes = renderEscPos(doc([{ kind: 'text', text: 'Plain line' }]), { paperWidthMm: 80, cut: false });
    const lines = decodeLines(bytes).filter((l) => l.length > 0);
    expect(lines).toEqual(['Plain line']);
  });
});

describe('renderEscPos — row right-alignment', () => {
  it('right-pads so the right value lands flush against the column width', () => {
    const bytes = renderEscPos(doc([{ kind: 'row', left: 'Subtotal', right: 'Rs. 240' }]), {
      paperWidthMm: 80,
      cut: false,
    });
    const lines = decodeLines(bytes);
    const rowLine = lines.find((l) => l.startsWith('Subtotal'));
    expect(rowLine).toBeDefined();
    expect(rowLine!.length).toBe(48);
    expect(rowLine!.endsWith('Rs. 240')).toBe(true);
  });

  it('never overflows the column width even when left + right cannot share a line', () => {
    const bytes = renderEscPos(
      doc([{ kind: 'row', left: 'A very long line item description that eats the whole line', right: 'Rs. 9999' }]),
      { paperWidthMm: 58, cut: false },
    );
    const lines = decodeLines(bytes).filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
    expect(lines.some((l) => l.trim().endsWith('Rs. 9999'))).toBe(true);
  });
});

describe('transliterate', () => {
  it('maps the documented fallbacks and leaves plain ASCII untouched', () => {
    expect(transliterate('₹120')).toBe('Rs.120');
    expect(transliterate('‘quoted’')).toBe("'quoted'");
    expect(transliterate('“quoted”')).toBe('"quoted"');
    expect(transliterate('2 × 3')).toBe('2 x 3');
    expect(transliterate('a — b')).toBe('a - b');
    expect(transliterate('Plain ASCII 123!?')).toBe('Plain ASCII 123!?');
  });

  it('falls back unknown non-ASCII letters (other scripts) to "?"', () => {
    expect(transliterate('café')).toBe('caf?'); // é
    expect(transliterate('日本語')).toBe('???'); // Japanese — letters, not symbols
  });

  it('drops emoji and other symbol/pictograph characters instead of printing "?"', () => {
    expect(transliterate('\u{1F600}')).toBe(''); // 😀 emoji (surrogate pair) — dropped, not '?'
    expect(transliterate('Order ready! 🎉')).toBe('Order ready! ');
    expect(transliterate('★ Special ★')).toBe(' Special '); // dingbats/misc symbols dropped too
  });

  it('maps middle dot / bullet variants and ellipsis to plain ASCII (PRN-7: the actual "Paid ? cash" bug)', () => {
    expect(transliterate('Paid · cash')).toBe('Paid - cash');
    expect(transliterate('Thank you for your order! · HIOC.')).toBe('Thank you for your order! - HIOC.');
    expect(transliterate('• bullet, ∙ operator')).toBe('- bullet, - operator');
    expect(transliterate('Loading…')).toBe('Loading...');
  });

  it('collapses non-breaking and narrow spaces to a plain space', () => {
    expect(transliterate('Rs. 120')).toBe('Rs. 120');
    expect(transliterate('a b c')).toBe('a b c');
  });

  it('never leaves a byte above 0x7e once rendered', () => {
    const bytes = renderEscPos(doc([{ kind: 'text', text: '₹100 café “deal” — 2×3 🎉' }]), {
      paperWidthMm: 80,
      cut: false,
    });
    for (const b of bytes) {
      expect(b).toBeLessThanOrEqual(0x7e);
    }
  });
});

// PRN-7 — a real paid order's receipt must never print a stray '?' at all.
// This mirrors the field report exactly: "Paid · cash" and the closing
// "Thank you for your order! · HIOC." line both had a '·' separator, which
// `transliterate` used to have no mapping for.
describe('renderEscPos — no "?" on a typical paid order receipt', () => {
  function decodedText(bytes: Uint8Array): string {
    // Reuses the byte-stream decoder above but only cares about the text —
    // command bytes never contain a literal '?' (0x3f) as a real parameter
    // in any of the commands this renderer emits, so a straight decode of
    // printable ASCII is enough to prove no stray '?' leaked into content.
    return decodeLines(bytes).join('\n');
  }

  it('produces zero "?" characters for a paid cash order with the standard separators', () => {
    const receiptDoc = doc([
      { kind: 'row', left: 'Payment', right: 'Paid · cash' },
      { kind: 'divider' },
      { kind: 'text', text: 'Thank you for your order! · HIOC.', align: 'center' },
    ]);
    const bytes = renderEscPos(receiptDoc, { paperWidthMm: 80, cut: true });
    expect(decodedText(bytes)).not.toContain('?');
  });

  it('produces zero "?" characters end-to-end for a realistic receipt TicketDoc', () => {
    const receiptDoc: TicketDoc = {
      type: 'receipt',
      orderId: 'order-1',
      blocks: [
        { kind: 'text', text: 'Test Cafe', align: 'center' },
        { kind: 'row', left: 'Order', right: 'HIOC-001042' },
        { kind: 'row', left: '2 × Espresso (Large)', right: 'Rs. 240' },
        { kind: 'text', text: '  + Sugar: Normal' },
        { kind: 'row', left: 'Total', right: 'Rs. 252', bold: true },
        { kind: 'row', left: 'Payment', right: 'Paid · cash' },
        { kind: 'row', left: 'Points balance', right: '120' },
        { kind: 'divider' },
        { kind: 'text', text: 'Thank you for your order! · HIOC.', align: 'center' },
      ],
    };
    const bytes = renderEscPos(receiptDoc, { paperWidthMm: 80, cut: true });
    expect(decodedText(bytes)).not.toContain('?');
  });
});

describe('renderEscPos — QR command', () => {
  it('emits the GS ( k model/size/error/store/print sequence', () => {
    const bytes = renderEscPos(doc([{ kind: 'qr', data: 'https://hioc.in/order/abc' }]), {
      paperWidthMm: 80,
      cut: false,
    });
    const gsParenK = [0x1d, 0x28, 0x6b];
    const hits = findAll(bytes, gsParenK);
    // model, size, error-correction, store, print — 5 GS ( k frames.
    expect(hits.length).toBe(5);
    // The data payload itself should be present in the byte stream (store frame).
    const dataBytes = Array.from('https://hioc.in/order/abc').map((c) => c.charCodeAt(0));
    expect(findAll(bytes, dataBytes)).toHaveLength(1);
  });
});

describe('renderEscPos — bold toggling stays balanced', () => {
  it('emits an equal number of ESC E 1 and ESC E 0 commands', () => {
    const bytes = renderEscPos(
      doc([
        { kind: 'text', text: 'normal one' },
        { kind: 'text', text: 'bold one', bold: true },
        { kind: 'text', text: 'normal two' },
        { kind: 'text', text: 'bold two, and the doc ends on bold', bold: true },
      ]),
      { paperWidthMm: 80, cut: true },
    );
    const boldOn = findAll(bytes, [0x1b, 0x45, 0x01]).length;
    const boldOff = findAll(bytes, [0x1b, 0x45, 0x00]).length;
    expect(boldOn).toBeGreaterThan(0);
    expect(boldOn).toBe(boldOff);
  });
});

// PRN-6 — the raster brand header (logo + "हाईओक" / "HIOC."). escpos.ts never
// builds the pixels itself (that's lib/print/brandHeaderRaster.ts, client-only
// and untestable here without a DOM) — these tests only pin the byte-level
// contract of a `raster` block that already carries its pixel data.
describe('renderEscPos — raster (GS v 0)', () => {
  it('emits exactly the GS v 0 header + data bytes for a tiny known bitmap', () => {
    // 8 dots wide (bytesPerRow = 1), 2 rows tall, arbitrary 1-bit pattern.
    const bytes = renderEscPos(
      doc([{ kind: 'raster', widthDots: 8, heightDots: 2, data: new Uint8Array([0xcc, 0x33]) }]),
      { paperWidthMm: 80, cut: false },
    );
    // GS v 0, m=0, xL=1 xH=0 (bytesPerRow=1), yL=2 yH=0 (2 rows), then the 2 data bytes.
    const expected = [0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x02, 0x00, 0xcc, 0x33];
    expect(findAll(bytes, expected)).toHaveLength(1);
  });

  it('bands a raster taller than 128 rows into 128/128/44, each its own GS v 0 command', () => {
    const widthDots = 8; // bytesPerRow = 1
    const heightDots = 300;
    const data = new Uint8Array(heightDots).fill(0xaa);
    const bytes = renderEscPos(doc([{ kind: 'raster', widthDots, heightDots, data }]), {
      paperWidthMm: 80,
      cut: false,
    });

    const headerStarts = findAll(bytes, [0x1d, 0x76, 0x30, 0x00]);
    expect(headerStarts).toHaveLength(3);
    const bandRowCounts = headerStarts.map((i) => bytes[i + 6] | (bytes[i + 7] << 8));
    expect(bandRowCounts).toEqual([128, 128, 44]);
    // Every band reports the same bytesPerRow (xL/xH) regardless of its height.
    for (const i of headerStarts) {
      expect(bytes[i + 4]).toBe(1); // xL
      expect(bytes[i + 5]).toBe(0); // xH
    }
  });

  it('centers the raster: ESC a 1 immediately precedes it and ESC a 0 immediately follows it', () => {
    const bytes = renderEscPos(
      doc([{ kind: 'raster', widthDots: 8, heightDots: 1, data: new Uint8Array([0xff]) }]),
      { paperWidthMm: 80, cut: false },
    );
    // ESC @ (2 bytes), then ESC a 1 (center) right before the raster.
    expect(Array.from(bytes.slice(2, 5))).toEqual([0x1b, 0x61, 0x01]);
    // Header (8 bytes) + 1 data byte, then ESC a 0 (left) right after.
    const afterRaster = 5 + 8 + 1;
    expect(Array.from(bytes.slice(afterRaster, afterRaster + 3))).toEqual([0x1b, 0x61, 0x00]);
  });

  it('emits nothing for a zero-size raster (no widthDots/heightDots)', () => {
    const bytes = renderEscPos(doc([{ kind: 'raster', widthDots: 0, heightDots: 0, data: new Uint8Array(0) }]), {
      paperWidthMm: 80,
      cut: false,
    });
    expect(findAll(bytes, [0x1d, 0x76, 0x30])).toHaveLength(0);
  });
});

describe('renderEscPos — brandHeader fallback', () => {
  it('falls back to centered, bold, double-size "HIOC." text when the placeholder reaches the renderer unresolved', () => {
    const bytes = renderEscPos(doc([{ kind: 'brandHeader' }]), { paperWidthMm: 80, cut: false });
    // No raster ever gets emitted for an unresolved brandHeader.
    expect(findAll(bytes, [0x1d, 0x76, 0x30])).toHaveLength(0);
    expect(findAll(bytes, [0x1b, 0x61, 0x01])).toHaveLength(1); // ESC a 1 — center
    expect(findAll(bytes, [0x1b, 0x45, 0x01])).toHaveLength(1); // ESC E 1 — bold on
    expect(findAll(bytes, [0x1d, 0x21, 0x11])).toHaveLength(1); // GS ! 0x11 — xlarge
    expect(decodeLines(bytes)).toContain('HIOC.');
  });
});
