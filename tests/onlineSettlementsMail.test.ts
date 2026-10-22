import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SENDER_DOMAINS,
  failedAuthentication,
  platformFromFileName,
  platformFromSender,
  safeFileName,
  senderDomainsFromEnv,
  wantsAttachment,
} from '@/lib/online-settlements/detect';
import {
  authResultsText,
  friendlyMailboxError,
  mailboxConfigFromEnv,
  partFileNames,
  pickReportMessages,
  searchQuery,
} from '@/lib/online-settlements/mailbox';

// Which emails count as platform reports, and the mailbox settings
// (lib/online-settlements/detect.ts, mailbox.ts). The IMAP session itself is
// exercised in onlineSettlementsSync.test.ts, against a stand-in for the server.

describe('trusted senders', () => {
  const d = DEFAULT_SENDER_DOMAINS;

  it('accepts the platform domains and their subdomains', () => {
    expect(platformFromSender('noreply@zomato.com', d)).toBe('zomato');
    expect(platformFromSender('Payouts@Mailer.Zomato.com', d)).toBe('zomato');
    expect(platformFromSender('settlements@swiggy.in', d)).toBe('swiggy');
    expect(platformFromSender('x@partner.swiggy.com', d)).toBe('swiggy');
  });

  it('rejects look-alike domains and other senders', () => {
    expect(platformFromSender('noreply@zomato.com.evil.io', d)).toBeNull();
    expect(platformFromSender('noreply@notzomato.com', d)).toBeNull();
    expect(platformFromSender('owner@gmail.com', d)).toBeNull();
    expect(platformFromSender('', d)).toBeNull();
  });

  it('can be overridden per platform from the environment', () => {
    const env = senderDomainsFromEnv({ ONLINE_REPORTS_ZOMATO_DOMAINS: ' @zomato.in , zomato.com ' });
    expect(env.zomato).toEqual(['zomato.in', 'zomato.com']);
    expect(env.swiggy).toEqual(d.swiggy);
  });

  it('treats a DMARC failure as forged', () => {
    expect(failedAuthentication('mx.google.com; dkim=pass; spf=pass; dmarc=pass (p=REJECT)')).toBe(false);
    expect(failedAuthentication(['mx.google.com; spf=softfail', 'dmarc=fail (p=NONE sp=NONE)'])).toBe(true);
    expect(failedAuthentication(null)).toBe(false);
  });
});

describe('attachments', () => {
  it('takes only the .xlsx or .csv from Zomato, any spreadsheet or zip from Swiggy', () => {
    expect(wantsAttachment('zomato', 'Zomato_Settlement_Report_1.xlsx')).toBe(true);
    expect(wantsAttachment('zomato', 'Invoice.pdf')).toBe(false);
    expect(wantsAttachment('zomato', 'summary.csv')).toBe(true);
    expect(wantsAttachment('swiggy', 'annexure.csv')).toBe(true);
    expect(wantsAttachment('swiggy', 'annexure.zip')).toBe(true);
    expect(wantsAttachment('swiggy', 'invoice.pdf')).toBe(false);
  });

  it('guesses the platform from a file name and makes names safe for storage', () => {
    expect(platformFromFileName('Zomato_Settlement_Report_x.xlsx')).toBe('zomato');
    expect(platformFromFileName('swiggy-payout.csv')).toBe('swiggy');
    expect(platformFromFileName('report.xlsx')).toBeNull();
    expect(safeFileName('Payout (Week 40) ₹.xlsx')).toBe('Payout_Week_40_.xlsx');
    expect(safeFileName('///')).toBe('report');
  });
});

describe('mailbox settings', () => {
  it('is off until both user and app password are set', () => {
    expect(mailboxConfigFromEnv({})).toBeNull();
    expect(mailboxConfigFromEnv({ ONLINE_REPORTS_IMAP_USER: 'r@gmail.com' })).toBeNull();
  });

  it('defaults to Gmail INBOX, two weeks back, and accepts the app password with spaces', () => {
    const cfg = mailboxConfigFromEnv({ ONLINE_REPORTS_IMAP_USER: 'r@gmail.com', ONLINE_REPORTS_IMAP_PASSWORD: 'abcd efgh ijkl mnop' });
    expect(cfg).toMatchObject({ host: 'imap.gmail.com', port: 993, mailbox: 'INBOX', lookbackDays: 14, pass: 'abcdefghijklmnop' });
  });

  it('caps the look-back and honours overrides', () => {
    const cfg = mailboxConfigFromEnv({
      ONLINE_REPORTS_IMAP_USER: 'r@zoho.in',
      ONLINE_REPORTS_IMAP_PASSWORD: 'x',
      ONLINE_REPORTS_IMAP_HOST: 'imap.zoho.in',
      ONLINE_REPORTS_IMAP_MAILBOX: '[Gmail]/All Mail',
      ONLINE_REPORTS_LOOKBACK_DAYS: '9999',
    });
    expect(cfg).toMatchObject({ host: 'imap.zoho.in', mailbox: '[Gmail]/All Mail', lookbackDays: 400 });
  });

  it('searches every trusted domain since the look-back date', () => {
    const since = new Date('2026-10-08T00:00:00Z');
    expect(searchQuery(since, { zomato: ['zomato.com'], swiggy: [] })).toEqual({ since, from: 'zomato.com' });
    expect(searchQuery(since, DEFAULT_SENDER_DOMAINS)).toEqual({
      since,
      or: [{ from: 'zomato.com' }, { from: 'swiggy.in' }, { from: 'swiggy.com' }],
    });
  });

  it('explains login and connection failures in plain words', () => {
    expect(friendlyMailboxError(Object.assign(new Error('Command failed'), { responseText: 'Invalid credentials (Failure)' }))).toMatch(/app password/);
    expect(friendlyMailboxError(new Error('getaddrinfo ENOTFOUND imap.gmial.com'))).toMatch(/Could not reach the mail server/);
  });
});

describe('choosing which emails to download', () => {
  const msg = (uid: number, from: string, fileNames: string[], messageId: string | null = `<${uid}@x>`, extra: { size?: number | null; authResults?: string | null } = {}) => ({
    uid, from, fileNames, messageId, subject: `Report ${uid}`, size: extra.size ?? 200_000, authResults: extra.authResults ?? null,
  });

  it('finds attachment names anywhere in the MIME tree', () => {
    const tree = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'multipart/alternative', childNodes: [{ type: 'text/plain' }, { type: 'text/html' }] },
        { type: 'application/vnd.ms-excel', disposition: 'attachment', dispositionParameters: { filename: 'Zomato_Settlement_Report.xlsx' } },
        { type: 'application/pdf', parameters: { name: 'Invoice.pdf' } },
      ],
    };
    expect(partFileNames(tree as never)).toEqual(['Zomato_Settlement_Report.xlsx', 'Invoice.pdf']);
  });

  it('downloads only unread platform emails that carry a report, newest first, capped', () => {
    const list = [
      msg(1, 'noreply@zomato.com', ['Zomato_Settlement_Report_1.xlsx']),
      msg(2, 'noreply@zomato.com', []), // promotional: no attachment
      msg(3, 'noreply@zomato.com', ['Invoice.pdf']), // invoice only
      msg(4, 'noreply@zomato.com', ['Zomato_Settlement_Report_2.xlsx'], '<read@x>'), // already processed
      msg(5, 'owner@gmail.com', ['Zomato_Settlement_Report_fwd.xlsx']), // not a platform address
      msg(6, 'payouts@swiggy.in', ['annexure.csv']),
      msg(7, 'noreply@zomato.com', ['Zomato_Settlement_Report_3.xlsx']),
    ];
    const { picked, candidates } = pickReportMessages(list, new Set(['<read@x>']), DEFAULT_SENDER_DOMAINS, 2);
    expect(candidates).toBe(3);
    expect(picked.map((m) => m.uid)).toEqual([7, 6]);
    // the next run, with those two processed, reaches the older one
    const next = pickReportMessages(list, new Set(['<read@x>', '<7@x>', '<6@x>']), DEFAULT_SENDER_DOMAINS, 2);
    expect(next.picked.map((m) => m.uid)).toEqual([1]);
  });

  it('drops a forged (DMARC-failing) or oversize email before any download, without counting it', () => {
    const forged = 'mx.google.com; dkim=fail; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=zomato.com';
    const list = [
      msg(1, 'noreply@zomato.com', ['Zomato_Settlement_Report_1.xlsx']),
      msg(2, 'noreply@zomato.com', ['Zomato_Settlement_Report_2.xlsx'], '<forged@x>', { authResults: forged }),
      msg(3, 'noreply@zomato.com', ['Zomato_Settlement_Report_3.xlsx'], '<big@x>', { size: 26 * 1024 * 1024 }),
      msg(4, 'noreply@zomato.com', ['Zomato_Settlement_Report_4.xlsx'], '<ok@x>', { authResults: 'mx.google.com; dkim=pass; dmarc=pass', size: 25 * 1024 * 1024 }),
      msg(5, 'noreply@zomato.com', ['Invoice.pdf'], '<invoice@x>', { authResults: forged }), // nothing to read anyway
      msg(6, 'noreply@zomato.com', ['Zomato_Settlement_Report_6.xlsx'], '<nosize@x>', { size: null }),
    ];
    const { picked, candidates, rejected } = pickReportMessages(list, new Set(), DEFAULT_SENDER_DOMAINS);
    expect(picked.map((m) => m.uid)).toEqual([6, 4, 1]);
    expect(candidates).toBe(3);
    expect(rejected).toEqual([
      { subject: 'Report 2', from: 'noreply@zomato.com', reason: 'failed sender authentication (DMARC): possibly forged' },
      { subject: 'Report 3', from: 'noreply@zomato.com', reason: 'the email is larger than 25 MB' },
    ]);

    // A pile of forged mail doesn't take the places of the real ones.
    const flood = Array.from({ length: 5 }, (_, i) => msg(10 + i, 'noreply@zomato.com', ['Zomato_Settlement_Report_x.xlsx'], `<f${i}@x>`, { authResults: forged }));
    const capped = pickReportMessages([...list.slice(0, 1), ...flood], new Set(), DEFAULT_SENDER_DOMAINS, 2);
    expect(capped.picked.map((m) => m.uid)).toEqual([1]);
    expect(capped.rejected).toHaveLength(5);
  });

  it('reads the Authentication-Results header(s) from a header fetch', () => {
    const block = Buffer.from('Authentication-Results: mx.google.com;\r\n\tdkim=pass;\r\n dmarc=fail (p=NONE)\r\nAuthentication-Results: other.example; spf=pass\r\n\r\n');
    const text = authResultsText(block);
    expect(text).toContain('dmarc=fail');
    expect(failedAuthentication(text)).toBe(true);
    expect(failedAuthentication(authResultsText(Buffer.from('Authentication-Results: mx.google.com; dmarc=pass\r\n\r\n')))).toBe(false);
    expect(authResultsText(undefined)).toBeNull();
    expect(authResultsText(Buffer.from('\r\n\r\n'))).toBeNull();
  });
});
