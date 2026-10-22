import type { Platform } from './types';

// Which emails and attachments count as platform settlement reports. Pure, so
// the mailbox code (mailbox.ts) and the upload route share one set of rules.

/**
 * Sender domains trusted per platform. A message counts only if its From
 * address is at one of these domains or a subdomain of one (noreply@zomato.com,
 * payouts@mailer.swiggy.in). Override with ONLINE_REPORTS_ZOMATO_DOMAINS /
 * ONLINE_REPORTS_SWIGGY_DOMAINS (comma-separated) if a platform starts sending
 * from somewhere else.
 */
export const DEFAULT_SENDER_DOMAINS: Record<Platform, string[]> = {
  zomato: ['zomato.com'],
  swiggy: ['swiggy.in', 'swiggy.com'],
};

export function senderDomainsFromEnv(env: Record<string, string | undefined> = process.env): Record<Platform, string[]> {
  const list = (v: string | undefined, fallback: string[]) => {
    const parsed = (v ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);
    return parsed.length ? parsed : fallback;
  };
  return {
    zomato: list(env.ONLINE_REPORTS_ZOMATO_DOMAINS, DEFAULT_SENDER_DOMAINS.zomato),
    swiggy: list(env.ONLINE_REPORTS_SWIGGY_DOMAINS, DEFAULT_SENDER_DOMAINS.swiggy),
  };
}

/** The platform whose domain the address belongs to, or null. */
export function platformFromSender(address: string | null | undefined, domains: Record<Platform, string[]>): Platform | null {
  const at = (address ?? '').trim().toLowerCase().lastIndexOf('@');
  if (at < 0) return null;
  const host = (address as string).trim().toLowerCase().slice(at + 1);
  for (const platform of Object.keys(domains) as Platform[]) {
    if (domains[platform].some((d) => host === d || host.endsWith(`.${d}`))) return platform;
  }
  return null;
}

/** A guess from the file name alone ('Zomato_Settlement_Report_…', 'swiggy_payout_…'). */
export function platformFromFileName(name: string): Platform | null {
  if (/zomato/i.test(name)) return 'zomato';
  if (/swiggy/i.test(name)) return 'swiggy';
  return null;
}

/**
 * Attachments worth keeping: spreadsheets and zips (a platform may zip the
 * annexure). PDFs (tax invoices) and images are not settlement data.
 */
export function isReportAttachment(fileName: string): boolean {
  return /\.(xlsx|xls|csv|zip)$/i.test(fileName.trim());
}

/**
 * Which attachments of a platform's email to take. Zomato's settlement report
 * is an .xlsx (or a .csv with the same columns, if Zomato sends per-order rows
 * that way), so its other files are left alone. Swiggy's format isn't known
 * yet, so every spreadsheet-like file is kept for when its parser lands.
 */
export function wantsAttachment(platform: Platform, fileName: string): boolean {
  if (platform === 'zomato') return /\.(xlsx|csv)$/i.test(fileName.trim());
  return isReportAttachment(fileName);
}

/** Larger than any real weekly report; stops a stray huge file eating the cron's time. */
export const MAX_REPORT_BYTES = 15 * 1024 * 1024;

/**
 * True when the receiving server recorded that the message FAILED DMARC — i.e.
 * the From address was forged. Gmail and most providers stamp this in
 * Authentication-Results. A forged "Zomato" email must not be able to write
 * numbers onto the owner's dashboard. No header (some servers don't add one)
 * is not treated as a failure.
 */
export function failedAuthentication(authResults: string | string[] | null | undefined): boolean {
  const all = Array.isArray(authResults) ? authResults.join(' ') : authResults ?? '';
  return /\bdmarc=fail\b/i.test(all);
}

/** A file name safe to use inside a Storage path. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'report').slice(0, 120);
}
