import { normalizeLegacyPhone } from './phone';
import { parsePetpoojaDate } from './dates';
import type { ParsedLegacyCustomer, SkipCount } from './types';

// Parses the Petpooja "Customers Report" CSV. Like the order report, it
// opens with a title block, then a header line starting `Name,`:
// Name,Favourite,Phone,Email,"Date of Birth","Date of Anniversary",
// "Primary Address","Primary Locality","Do not send any Updates","GST No",
// "From Where",Created,Tags
//
// The title block's "Restaurant Address" field is itself a quoted field
// containing a literal newline, so this needs a real RFC-4180 parser (no
// dependency) rather than a naive text.split('\n').

const HEADER = [
  'Name',
  'Favourite',
  'Phone',
  'Email',
  'Date of Birth',
  'Date of Anniversary',
  'Primary Address',
  'Primary Locality',
  'Do not send any Updates',
  'GST No',
  'From Where',
  'Created',
  'Tags',
] as const;

const COL = {
  NAME: 0,
  FAVOURITE: 1,
  PHONE: 2,
  EMAIL: 3,
  DOB: 4,
  DOA: 5,
  ADDRESS: 6,
  LOCALITY: 7,
  GST_NO: 9,
  CREATED: 11,
} as const;

/** Minimal RFC-4180 parser: handles quoted fields containing commas and
 * embedded newlines, and doubled `""` as an escaped quote. Normalizes
 * CRLF/CR line endings to LF. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // swallow; \n (bare or following \r) ends the row
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }

  // Trailing field/row with no final newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function rawFromRow(row: string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  HEADER.forEach((name, i) => {
    raw[name] = row[i] ?? '';
  });
  return raw;
}

/** Classifies why normalizeLegacyPhone rejected a value, for the dry-run
 * report's skip breakdown. */
function phoneSkipReason(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("'")) s = s.slice(1);
  const digits = s.replace(/\D/g, '');
  if (!digits) return 'missing_phone';
  if (digits.length === 11) return 'landline';
  if (/^(\d)\1+$/.test(digits)) return 'placeholder_phone';
  return 'invalid_phone';
}

function bumpSkip(skipped: Map<string, number>, reason: string): void {
  skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
}

export function parseCustomerCsv(text: string): { customers: ParsedLegacyCustomer[]; skipped: SkipCount[] } {
  const rows = parseCsvRows(text);
  const headerIdx = rows.findIndex((row) => (row[0] ?? '').trim() === 'Name');
  if (headerIdx === -1) {
    return { customers: [], skipped: [{ reason: 'no_header_row', count: 1 }] };
  }

  const customers: ParsedLegacyCustomer[] = [];
  const skipped = new Map<string, number>();

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c.trim() === '')) {
      continue; // trailing blank line
    }

    const phoneRaw = row[COL.PHONE] ?? '';
    const phone = normalizeLegacyPhone(phoneRaw);
    if (!phone) {
      bumpSkip(skipped, phoneSkipReason(phoneRaw));
      continue;
    }

    customers.push({
      phone,
      name: (row[COL.NAME] ?? '').trim(),
      email: (row[COL.EMAIL] ?? '').trim(),
      date_of_birth: parsePetpoojaDate(row[COL.DOB] ?? ''),
      date_of_anniversary: parsePetpoojaDate(row[COL.DOA] ?? ''),
      address: (row[COL.ADDRESS] ?? '').trim(),
      locality: (row[COL.LOCALITY] ?? '').trim(),
      gstin: (row[COL.GST_NO] ?? '').trim(),
      is_favourite: (row[COL.FAVOURITE] ?? '').trim() === 'Yes',
      petpooja_created_on: parsePetpoojaDate(row[COL.CREATED] ?? ''),
      raw: rawFromRow(row),
    });
  }

  return { customers, skipped: [...skipped].map(([reason, count]) => ({ reason, count })) };
}
