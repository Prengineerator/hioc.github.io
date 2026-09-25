// Petpooja timestamps are wall-clock Asia/Kolkata (IST, UTC+5:30) with no
// timezone marker of their own: 'Created' is always 'D Mon YYYY HH:MM:SS'
// and the customer report's date columns are always 'D Mon YYYY'. Both are
// parsed by hand (no locale-dependent Date.parse) so a server running in
// any timezone gets the same result byte-for-byte.

const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

const DATETIME_RE = /^(\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{1,2}) (\w{3}) (\d{4})$/;

/** '27 Jun 2025 00:11:03' (IST wall clock) -> '2025-06-27T00:11:03+05:30'. */
export function parsePetpoojaDateTime(s: string): string {
  const m = DATETIME_RE.exec(s.trim());
  if (!m) throw new Error(`Invalid Petpooja datetime: ${JSON.stringify(s)}`);
  const [, d, mon, y, hh, mm, ss] = m;
  const month = MONTHS[mon];
  if (!month) throw new Error(`Invalid Petpooja datetime month: ${JSON.stringify(s)}`);
  return `${y}-${month}-${d.padStart(2, '0')}T${hh}:${mm}:${ss}+05:30`;
}

/** '25 Sep 2026' -> '2026-09-25'. Blank/unparseable -> null (DOB, DOA and
 * Created in the customer report are frequently empty). */
export function parsePetpoojaDate(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const m = DATE_RE.exec(trimmed);
  if (!m) return null;
  const [, d, mon, y] = m;
  const month = MONTHS[mon];
  if (!month) return null;
  return `${y}-${month}-${d.padStart(2, '0')}`;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Petpooja's fiscal year runs 1 Apr - 31 Mar (e.g. '2025-26' = 1 Apr 2025
 * through 31 Mar 2026), and `Order No.` resets at the boundary. Uses the
 * IST *calendar date* of the instant, so a bill at 31 Mar 23:59:59 IST and
 * one at 1 Apr 00:00:00 IST land in different fiscal years even though
 * `isoWithOffset` isn't required to carry a +05:30 offset itself.
 */
export function fiscalYearOf(isoWithOffset: string): string {
  const utcMs = new Date(isoWithOffset).getTime();
  const ist = new Date(utcMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1; // 1-12, read off the shifted-to-IST instant in UTC fields
  const startYear = m >= 4 ? y : y - 1;
  const endYy = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYy}`;
}
