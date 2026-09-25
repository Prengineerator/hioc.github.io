import { describe, expect, it } from 'vitest';
import { renderEscPos, transliterate, wrapText } from '@/lib/print/escpos';
import type { TicketDoc } from '@/lib/print/ticketDoc';

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

  it('falls back unknown non-ASCII characters to "?"', () => {
    expect(transliterate('café')).toBe('caf?'); // é
    expect(transliterate('\u{1F600}')).toBe('?'); // emoji (surrogate pair)
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
