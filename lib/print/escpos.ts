// PRN-3 — pure TicketDoc → ESC/POS byte renderer.
//
// Runs on the desktop shell (Electron main/renderer) as well as in tests, so
// this file must stay dependency-free and browser-safe: no `Buffer` (Node
// only), `Uint8Array` throughout instead. No Supabase, no DOM.
//
// ESC/POS is a byte protocol over Font A (7-bit ASCII, 1 byte/column), so
// everything here works in "columns", not pixels: 48 columns on 80mm paper,
// 32 on 58mm. Printers ship with code pages that don't reliably carry ₹, smart
// quotes, or other non-ASCII glyphs, so every string is transliterated to a
// 7-bit-safe fallback before it's written out (see `transliterate`).

import type { TicketAlign, TicketBlock, TicketColumn, TicketDoc } from '@/lib/print/ticketDoc';
import { BRAND_NAME_EN } from '@/lib/print/brandHeader';

const ESC = 0x1b;
const GS = 0x1d;

// `GS v 0` (raster bit image) takes a 2-byte row count (`yL yH`), but many
// cheap 80mm printers' input buffers choke on one huge band — 128 rows keeps
// each band comfortably small while still being well within the 2-byte limit.
const MAX_RASTER_BAND_ROWS = 128;

type Size = 'normal' | 'large' | 'xlarge';

/**
 * How the paper is cut when `cut: true` (PRN-3 field report: many cheaper
 * 80mm printers only implement ESC/POS "function A" (`GS V 0`/`GS V 1`) or
 * the legacy `ESC i`/`ESC m` commands, not "function B" (`GS V 66`) that used
 * to be hard-coded here — so those printers silently never cut.
 * - standard: `GS V 66 0` (function B). It feeds to the cutting position
 *   itself, so no separate feed is sent first — sending one anyway is what
 *   caused the "huge wastage" bug (double feed).
 * - partial / full: function A (`GS V 1` / `GS V 0`), which does NOT feed to
 *   the cutter itself, so a feed is sent first.
 * - legacy: `ESC i`, likewise preceded by a feed.
 */
export type CutMode = 'standard' | 'partial' | 'full' | 'legacy';

const ALIGN_CODE: Record<TicketAlign, number> = { left: 0, center: 1, right: 2 };
const SIZE_CODE: Record<Size, number> = { normal: 0x00, large: 0x01, xlarge: 0x11 };

// Lines to feed so the print head reaches the cutter (or, when not cutting,
// the tear bar) before a non-self-feeding trailer command. 4 lines at the
// printer's default 1/6" (~4.23mm) line spacing is ~17mm — the typical
// print-head-to-cutter (or tear-bar) distance on 58/80mm thermal printers.
const FEED_TO_CUTTER_LINES = 4;

// Characters known to appear in ticket content that have no place on a
// 7-bit ASCII code page. Anything else non-ASCII falls back to '?' — except
// the two broader classes handled after the map lookup in `transliterate`
// below (emoji/symbols, which are dropped; and non-breaking/narrow spaces,
// which become a plain space).
//
// PRN-7 field report: a real receipt printed "Paid ? cash" and "Thank you
// for your order! ? HIOC." — both from '·' (U+00B7 MIDDLE DOT), used as a
// separator in lib/print/ticketModel.ts, having no entry here at all and so
// falling through to the generic '?' fallback. '•' and '∙' are the same kind
// of separator glyph and would hit the same bug the moment either showed up
// in ticket content, so all three are mapped alongside it.
const CHAR_MAP: Record<string, string> = {
  '₹': 'Rs.',
  '‘': "'", // ‘
  '’': "'", // ’
  '“': '"', // “
  '”': '"', // ”
  '×': 'x',
  '—': '-', // em dash
  '–': '-', // en dash
  '·': '-', // middle dot (U+00B7) — PRN-7: the actual cause of the "?" bug
  '•': '-', // bullet
  '∙': '-', // bullet operator
  '…': '...', // horizontal ellipsis
};

// Non-breaking/narrow space variants that visually read as a plain space but
// aren't printable ASCII 0x20 — collapse them to one before the generic
// range check, rather than letting them fall through to '?'.
const SPACE_CHARS = new Set([' ', ' ', ' ', ' ', ' ']);

/**
 * Whether `ch` is an emoji or other symbol/pictograph — the Unicode blocks a
 * thermal printer's code page could never represent meaningfully. These are
 * dropped entirely (rendered as nothing) rather than printed as '?', since a
 * missing decoration reads better on a receipt than a wall of "?"s. Letters
 * from other scripts (e.g. a stray Devanagari character outside the
 * rasterized brand header) are NOT covered here and still fall back to '?'.
 */
function isSymbolOrPictograph(code: number): boolean {
  return (
    (code >= 0x2600 && code <= 0x27bf) || // Misc symbols, Dingbats
    (code >= 0x1f300 && code <= 0x1faff) || // Misc Symbols & Pictographs, Emoticons, Transport, Supplemental Symbols, Symbols & Pictographs Extended-A
    (code >= 0x2190 && code <= 0x21ff) || // Arrows
    (code >= 0x2300 && code <= 0x23ff) || // Misc Technical (includes many emoji-ish symbols)
    (code >= 0x2b00 && code <= 0x2bff) || // Misc Symbols and Arrows
    (code >= 0xfe00 && code <= 0xfe0f) || // Variation selectors (emoji presentation)
    code === 0x200d // zero-width joiner (emoji ZWJ sequences)
  );
}

/**
 * Maps a string to 7-bit printable ASCII: known symbols get a sensible
 * fallback (₹ → "Rs.", smart quotes → straight, × → x, — / · / • / ∙ → -,
 * … → "...", non-breaking/narrow spaces → " "), emoji/pictographs are
 * dropped rather than printed, and any remaining non-ASCII character (e.g. a
 * letter from another script) falls back to '?'. `\n` passes through
 * unchanged — callers only ever feed it deliberately as a line separator.
 */
export function transliterate(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\n') {
      out += ch;
      continue;
    }
    const mapped = CHAR_MAP[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (SPACE_CHARS.has(ch)) {
      out += ' ';
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
      continue;
    }
    if (isSymbolOrPictograph(code)) {
      continue; // dropped, not '?'
    }
    out += '?';
  }
  return out;
}

/**
 * Greedy word wrap to a fixed column width. Guarantees no returned line
 * exceeds `width` characters, hard-breaking a single token longer than the
 * column (a long name with no spaces) rather than overflowing it.
 */
export function wrapText(text: string, width: number): string[] {
  const col = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let remaining = para;
    if (remaining.length === 0) {
      lines.push('');
      continue;
    }
    while (remaining.length > col) {
      const breakAt = remaining.lastIndexOf(' ', col);
      if (breakAt > 0) {
        lines.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt + 1);
      } else {
        // No usable space to break on — hard-cut at the column width.
        lines.push(remaining.slice(0, col));
        remaining = remaining.slice(col);
      }
    }
    lines.push(remaining);
  }
  return lines.length > 0 ? lines : [''];
}

/** Pads/truncates `text` to exactly `width` characters for the given alignment. */
function padToWidth(text: string, width: number, align: TicketAlign): string {
  if (text.length >= width) return text.slice(0, width);
  const pad = width - text.length;
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + text + ' '.repeat(pad - left);
  }
  return text + ' '.repeat(pad);
}

/** Total width `columns` needs (each column's `minWidth`, plus one space of
 * gap between every pair of adjacent columns) — the floor `layoutColumns`
 * checks against `totalCols` to decide whether an `optional` column fits. */
function requiredWidth(columns: TicketColumn[]): number {
  const minSum = columns.reduce((sum, c) => sum + Math.max(1, c.minWidth ?? 1), 0);
  return minSum + Math.max(0, columns.length - 1);
}

/**
 * Drops `optional` columns (in the order they appear), one at a time, until
 * the remaining columns' `minWidth`s (+ gaps) fit `totalCols` — or none are
 * left to drop. This is how the item table's Price column disappears at
 * 32 cols (58mm) but never at 48 cols (80mm), where it always fits.
 */
function pickColumns(columns: TicketColumn[], totalCols: number): TicketColumn[] {
  let cols = columns;
  while (requiredWidth(cols) > totalCols) {
    const dropIdx = cols.findIndex((c) => c.optional);
    if (dropIdx === -1) break;
    cols = cols.filter((_, i) => i !== dropIdx);
  }
  return cols;
}

/**
 * Distributes `totalCols` (minus one gap column between each pair of
 * columns) across `columns` by relative `weight`, with each column never
 * going below its `minWidth`. Every column starts AT its `minWidth`, then
 * whatever's left over (`available - sum(minWidths)`) is handed out by
 * weight — never the other way around (computing a weighted share first and
 * only enforcing `minWidth` after can, for some weight/minWidth
 * combinations, push the total over `available` and silently shrink a later
 * column back below ITS `minWidth` to compensate; starting from the floor
 * makes that impossible). Any rounding remainder from the weighted split
 * lands on the last column, so the returned widths sum to exactly
 * `totalCols - gaps` whenever the minWidths themselves fit (the normal
 * case — `pickColumns` already dropped whatever didn't); if even the
 * minWidths don't fit (no optional column left to drop), every column gets
 * exactly its minWidth and the row is left to overflow `totalCols` rather
 * than cut a column's content short.
 */
function columnWidths(columns: TicketColumn[], totalCols: number): number[] {
  if (columns.length === 0) return [];
  const gaps = columns.length - 1;
  const available = Math.max(columns.length, totalCols - gaps);
  const minWidths = columns.map((c) => Math.max(1, c.minWidth ?? 1));
  const minSum = minWidths.reduce((a, b) => a + b, 0);
  const extra = Math.max(0, available - minSum);
  if (extra === 0) return minWidths;

  const totalWeight = columns.reduce((sum, c) => sum + c.weight, 0) || columns.length;
  const widths = minWidths.slice();
  let used = 0;
  columns.forEach((c, i) => {
    const share = Math.floor((c.weight / totalWeight) * extra);
    widths[i] += share;
    used += share;
  });
  widths[widths.length - 1] += extra - used; // rounding remainder
  return widths;
}

/**
 * Lays a `columns` block out into fixed-width text lines for `totalCols`
 * columns of paper: computes each column's real character width (dropping
 * `optional` columns first if they don't all fit — see `pickColumns`), word-
 * wraps each column's text independently (`wrapText`, so a long item name
 * wraps within its own column instead of overflowing into the next one),
 * and re-joins column N's Nth wrapped line (or blank, once that column runs
 * out of lines) with a single space between columns. Every returned line is
 * therefore exactly `totalCols` characters wide.
 */
export function layoutColumns(columns: TicketColumn[], totalCols: number): string[] {
  const cols = pickColumns(columns, totalCols);
  if (cols.length === 0) return [];
  const widths = columnWidths(cols, totalCols);
  const wrapped = cols.map((c, i) => wrapText(transliterate(c.text), widths[i]));
  const lineCount = Math.max(1, ...wrapped.map((w) => w.length));
  const lines: string[] = [];
  for (let li = 0; li < lineCount; li++) {
    const parts = cols.map((c, i) => padToWidth(wrapped[i][li] ?? '', widths[i], c.align ?? 'left'));
    lines.push(parts.join(' '));
  }
  return lines;
}

function qrCommandBytes(data: string): number[] {
  const bytes: number[] = [];
  const dataBytes = Array.from(data).map((c) => c.charCodeAt(0) & 0xff);

  // Model 2, size 6 (module dots), error correction level M — the common,
  // widely-supported Epson-compatible ESC/POS QR command set (GS ( k).
  bytes.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // model 2
  bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06); // size 6
  bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31); // error correction M

  const storeLen = dataBytes.length + 3;
  const pL = storeLen & 0xff;
  const pH = (storeLen >> 8) & 0xff;
  bytes.push(GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...dataBytes); // store

  bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // print

  return bytes;
}

/**
 * `GS v 0` bytes for one raster band: `1D 76 30 00 xL xH yL yH` + the band's
 * row data. `bytesPerRow` is the same for every band of one image (it's
 * `ceil(widthDots / 8)`, independent of height); `rows` is this band's height
 * in dots (≤ `MAX_RASTER_BAND_ROWS`).
 */
function rasterBandBytes(bytesPerRow: number, rows: number, bandData: Uint8Array): number[] {
  const bytes: number[] = [
    GS,
    0x76,
    0x30,
    0x00, // m = 0 (normal mode, no scaling)
    bytesPerRow & 0xff,
    (bytesPerRow >> 8) & 0xff,
    rows & 0xff,
    (rows >> 8) & 0xff,
  ];
  for (let i = 0; i < bandData.length; i++) bytes.push(bandData[i]);
  return bytes;
}

/**
 * Renders a printer-neutral TicketDoc to raw ESC/POS bytes for a given paper
 * width. Font A columns: 48 @ 80mm, 32 @ 58mm; halved again under `xlarge`
 * (double-width) text. Voided (`strike`) lines get a "[VOID] " prefix since
 * ESC/POS has no strikethrough. `raster` blocks (the rasterized brand header,
 * or any other 1-bit image) print centered via `GS v 0`, split into bands of
 * at most `MAX_RASTER_BAND_ROWS` rows so no single command overwhelms a
 * cheap printer's input buffer; a `brandHeader` block that reached here
 * unresolved (rasterization unavailable or failed — see
 * `lib/print/brandHeaderRaster.ts`) falls back to centered double-size
 * "HIOC." text so a bad logo/font load can never break a print job. Trailer:
 * when `cut` is false, a tear-off feed (the tear bar still needs paper fed
 * to it); when `cut` is true, the cut command for `cutMode` (default
 * `'standard'`) — see `CutMode` above for why `standard` sends no separate
 * feed while the others do.
 */
export function renderEscPos(
  doc: TicketDoc,
  opts: { paperWidthMm: 58 | 80; cut: boolean; cutMode?: CutMode },
): Uint8Array {
  const cols = opts.paperWidthMm === 80 ? 48 : 32;
  const bytes: number[] = [];

  let align: TicketAlign = 'left';
  let bold = false;
  let size: Size = 'normal';

  const setAlign = (a: TicketAlign) => {
    if (a === align) return;
    align = a;
    bytes.push(ESC, 0x61, ALIGN_CODE[a]);
  };
  const setBold = (on: boolean) => {
    if (on === bold) return;
    bold = on;
    bytes.push(ESC, 0x45, on ? 1 : 0);
  };
  const setSize = (s: Size) => {
    if (s === size) return;
    size = s;
    bytes.push(GS, 0x21, SIZE_CODE[s]);
  };
  const encodeLine = (line: string) => {
    for (const ch of line) bytes.push(ch.charCodeAt(0) & 0xff);
    bytes.push(0x0a);
  };
  const widthFor = (s: Size) => (s === 'xlarge' ? Math.max(1, Math.floor(cols / 2)) : cols);

  const emitText = (block: Extract<TicketBlock, { kind: 'text' }>) => {
    const a = block.align ?? 'left';
    const b = !!block.bold;
    const s = block.size ?? 'normal';
    setAlign(a);
    setBold(b);
    setSize(s);
    const raw = transliterate(block.strike ? `[VOID] ${block.text}` : block.text);
    // `indent` only makes sense against left alignment — ESC/POS's own
    // centered/right alignment (`ESC a`) already positions the whole line,
    // so hand-adding spaces there would just get re-centered/re-aligned
    // with them baked in. The wrap width shrinks by `indent` so the
    // indented line still fits `cols`, and EVERY wrapped line (not just the
    // first) gets the same prefix — a hanging indent, not a one-off one.
    const indent = a === 'left' ? Math.max(0, Math.min(widthFor(s) - 1, block.indent ?? 0)) : 0;
    const prefix = ' '.repeat(indent);
    for (const line of wrapText(raw, widthFor(s) - indent)) {
      encodeLine(prefix + line);
    }
  };

  const emitRow = (block: Extract<TicketBlock, { kind: 'row' }>) => {
    setAlign('left');
    setBold(!!block.bold);
    setSize(block.size ?? 'normal');
    const width = cols;
    const leftRaw = transliterate(block.left);
    const rightRaw = transliterate(block.right);
    const leftLines = wrapText(leftRaw, width);
    for (let i = 0; i < leftLines.length - 1; i++) {
      encodeLine(leftLines[i]);
    }
    const lastLeft = leftLines[leftLines.length - 1];
    if (rightRaw.length > width) {
      // The right-hand value alone doesn't fit one line — keep the left text
      // on its own line(s) and wrap the value separately, right-aligned.
      encodeLine(lastLeft);
      for (const rLine of wrapText(rightRaw, width)) {
        encodeLine(rLine.length < width ? rLine.padStart(width) : rLine);
      }
    } else if (lastLeft.length + 1 + rightRaw.length > width) {
      // Fits neither line — right-hand value gets its own right-aligned line.
      encodeLine(lastLeft);
      encodeLine(rightRaw.padStart(width));
    } else {
      const gap = width - lastLeft.length - rightRaw.length;
      encodeLine(lastLeft + ' '.repeat(gap) + rightRaw);
    }
  };

  const emitColumns = (block: Extract<TicketBlock, { kind: 'columns' }>) => {
    setAlign('left');
    setBold(!!block.bold);
    setSize('normal');
    for (const line of layoutColumns(block.columns, cols)) {
      encodeLine(line);
    }
  };

  const emitRaster = (block: Extract<TicketBlock, { kind: 'raster' }>) => {
    const widthDots = Math.max(0, Math.floor(block.widthDots));
    const heightDots = Math.max(0, Math.floor(block.heightDots));
    if (widthDots === 0 || heightDots === 0) return;
    const bytesPerRow = Math.ceil(widthDots / 8);

    setAlign('center');
    let row = 0;
    while (row < heightDots) {
      const bandRows = Math.min(MAX_RASTER_BAND_ROWS, heightDots - row);
      const start = row * bytesPerRow;
      const end = start + bandRows * bytesPerRow;
      bytes.push(...rasterBandBytes(bytesPerRow, bandRows, block.data.subarray(start, end)));
      row += bandRows;
    }
    setAlign('left');
  };

  // Placeholder for an unresolved `brandHeader` block (see the function-level
  // doc comment above) — centered, bold, double-width+height "HIOC.".
  const emitBrandHeaderFallback = () => {
    setAlign('center');
    setBold(true);
    setSize('xlarge');
    encodeLine(transliterate(BRAND_NAME_EN));
  };

  // The trailer — feed and/or cut, see `CutMode` above. Emitted after the last
  // block, and also for every `cut` block, so each slip of a split KOT leaves
  // the printer exactly the way a whole ticket does.
  const emitTrailer = () => {
    setAlign('left');
    setBold(false);
    setSize('normal');
    if (!opts.cut) {
      bytes.push(ESC, 0x64, FEED_TO_CUTTER_LINES); // tear-off feed — no cutter, the tear bar needs it
    } else {
      const mode = opts.cutMode ?? 'standard';
      if (mode === 'standard') {
        // GS V 66 0 (function B) feeds to the cutting position itself — an
        // extra feed first would double-feed and waste paper.
        bytes.push(GS, 0x56, 0x42, 0x00);
      } else {
        bytes.push(ESC, 0x64, FEED_TO_CUTTER_LINES); // function A / legacy don't feed themselves
        if (mode === 'partial') {
          bytes.push(GS, 0x56, 0x01); // GS V 1 — function A partial cut
        } else if (mode === 'full') {
          bytes.push(GS, 0x56, 0x00); // GS V 0 — function A full cut
        } else {
          bytes.push(ESC, 0x69); // ESC i — legacy full cut
        }
      }
    }
  };

  bytes.push(ESC, 0x40); // ESC @ — initialize

  for (const block of doc.blocks) {
    switch (block.kind) {
      case 'text':
        emitText(block);
        break;
      case 'row':
        emitRow(block);
        break;
      case 'columns':
        emitColumns(block);
        break;
      case 'divider':
        setAlign('left');
        setBold(false);
        setSize('normal');
        encodeLine('-'.repeat(cols));
        break;
      case 'feed':
        bytes.push(ESC, 0x64, Math.max(0, Math.min(255, Math.floor(block.lines))));
        break;
      case 'cut':
        emitTrailer();
        break;
      case 'qr':
        bytes.push(...qrCommandBytes(transliterate(block.data)));
        break;
      case 'raster':
        emitRaster(block);
        break;
      case 'brandHeader':
        emitBrandHeaderFallback();
        break;
      default:
        break;
    }
  }

  // The trailer first leaves the printer in its default state (no dangling
  // bold/alignment/size) regardless of how the last block left it, then feeds
  // and/or cuts — nothing else in this renderer emits a feed after this point.
  emitTrailer();

  return new Uint8Array(bytes);
}
