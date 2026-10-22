import 'server-only';
import { ImapFlow, type MessageStructureObject, type SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  failedAuthentication,
  MAX_MESSAGE_BYTES,
  MAX_REPORT_BYTES,
  platformFromSender,
  senderDomainsFromEnv,
  wantsAttachment,
} from './detect';
import type { Platform } from './types';

// Reads the café's mailbox over IMAP for the platforms' settlement emails and
// hands their report attachments over, one email at a time. Read-only: it
// never marks, moves or deletes a message, so the owner's inbox looks exactly
// as before. Whether a file was already read is decided later by its hash
// (ingest.ts), not by email flags, so looking back over the same days every
// morning is safe.
//
// Set up (docs/ONLINE-SETTLEMENTS.md): a Gmail (or any IMAP) mailbox that
// receives the reports, and an APP PASSWORD for it — never the real password.
//   ONLINE_REPORTS_IMAP_USER       reports@… or the owner's address
//   ONLINE_REPORTS_IMAP_PASSWORD   the 16-character app password
//   ONLINE_REPORTS_IMAP_HOST       default imap.gmail.com
//   ONLINE_REPORTS_IMAP_PORT       default 993 (TLS)
//   ONLINE_REPORTS_IMAP_MAILBOX    default INBOX ('[Gmail]/All Mail' if a filter
//                                  archives the reports)
//   ONLINE_REPORTS_LOOKBACK_DAYS   default 14

export interface MailboxConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  mailbox: string;
  lookbackDays: number;
  domains: Record<Platform, string[]>;
}

export function mailboxConfigFromEnv(env: Record<string, string | undefined> = process.env): MailboxConfig | null {
  const user = env.ONLINE_REPORTS_IMAP_USER?.trim();
  // Google shows app passwords in groups of four ("abcd efgh …"); both forms work.
  const pass = env.ONLINE_REPORTS_IMAP_PASSWORD?.replace(/\s+/g, '');
  if (!user || !pass) return null;
  const port = Number(env.ONLINE_REPORTS_IMAP_PORT || 993);
  const lookback = Number(env.ONLINE_REPORTS_LOOKBACK_DAYS || 14);
  return {
    host: env.ONLINE_REPORTS_IMAP_HOST?.trim() || 'imap.gmail.com',
    port: Number.isFinite(port) && port > 0 ? port : 993,
    user,
    pass,
    mailbox: env.ONLINE_REPORTS_IMAP_MAILBOX?.trim() || 'INBOX',
    lookbackDays: Number.isFinite(lookback) && lookback > 0 ? Math.min(lookback, 400) : 14,
    domains: senderDomainsFromEnv(env),
  };
}

export interface ReportAttachment {
  platform: Platform;
  fileName: string;
  bytes: Uint8Array;
  email: { messageId: string | null; from: string | null; subject: string | null; receivedAt: string | null };
}

export interface SkippedMessage {
  subject: string;
  from: string;
  reason: string;
}

/** One downloaded email, reduced to the report files in it. */
export interface ScannedMessage {
  messageId: string | null;
  platform: Platform;
  /** Report files within the size limit. */
  attachments: ReportAttachment[];
  /** What was left out of this email, and why (no report attachment, a file over the size limit). */
  skipped: SkippedMessage[];
}

export interface MailboxScan {
  /** Every message from a platform domain in the look-back window. */
  messagesFound: number;
  /** Of those, not yet read and carrying a report attachment: the ones picked for download. */
  messagesWithReports: number;
  /** Report-carrying messages not finished this run (over MAX_MESSAGES_PER_RUN, or out of time). */
  messagesLeft: number;
  /** Emails passed over without downloading them (failed DMARC, too large). */
  skipped: SkippedMessage[];
}

/** Most report emails DOWNLOADED in one run; a long first look-back takes a few presses. */
export const MAX_MESSAGES_PER_RUN = 60;

/** File names of every part in a MIME tree that carries one (attachments, inline files). */
export function partFileNames(node: MessageStructureObject | undefined): string[] {
  if (!node) return [];
  const own = node.dispositionParameters?.filename ?? node.parameters?.name;
  const kids = (node.childNodes ?? []).flatMap(partFileNames);
  return own ? [own, ...kids] : kids;
}

export interface MessageSummary {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  fileNames: string[];
  /** Whole-email size in bytes, null when the server didn't say. */
  size: number | null;
  /** The Authentication-Results header(s) the receiving server stamped, null when there are none. */
  authResults: string | null;
}

/**
 * The Authentication-Results header(s) from a HEADER.FIELDS fetch as plain
 * text (folded lines joined), or null when the server sent none.
 */
export function authResultsText(headers: Uint8Array | undefined): string | null {
  const text = headers ? Buffer.from(headers).toString('utf8').replace(/\r?\n[ \t]+/g, ' ').trim() : '';
  return text || null;
}

/**
 * The messages worth downloading, from their envelopes, MIME structure, size
 * and Authentication-Results alone (cheap: no bodies): from a trusted domain,
 * not already processed (a report row or the seen-messages table carries its
 * Message-ID), and with an attachment that platform's reports come as. One
 * that failed DMARC (a forged sender) or is larger than MAX_MESSAGE_BYTES is
 * dropped here, before any download, and listed in `rejected`; it is not a
 * candidate, so forged mail can't fill the cap. Newest first, capped, so a
 * backfill makes progress every run instead of re-reading the same newest
 * emails — and the platforms' promotional mail, which has no report attached,
 * is never downloaded.
 */
export function pickReportMessages(
  messages: MessageSummary[],
  known: Set<string>,
  domains: Record<Platform, string[]>,
  max: number = MAX_MESSAGES_PER_RUN,
): { picked: MessageSummary[]; candidates: number; rejected: SkippedMessage[] } {
  const candidates: MessageSummary[] = [];
  const rejected: SkippedMessage[] = [];
  for (const m of messages) {
    const platform = platformFromSender(m.from, domains);
    if (!platform) continue;
    if (m.messageId && known.has(m.messageId)) continue;
    if (!m.fileNames.some((f) => wantsAttachment(platform, f))) continue;
    const why = failedAuthentication(m.authResults)
      ? 'failed sender authentication (DMARC): possibly forged'
      : m.size !== null && m.size > MAX_MESSAGE_BYTES
        ? `the email is larger than ${MAX_MESSAGE_BYTES / 1024 / 1024} MB`
        : null;
    if (why) rejected.push({ subject: m.subject, from: m.from, reason: why });
    else candidates.push(m);
  }
  const newestFirst = [...candidates].sort((a, b) => b.uid - a.uid);
  return { picked: newestFirst.slice(0, max), candidates: candidates.length, rejected };
}

/** The IMAP search: since the look-back date, from any trusted domain. */
export function searchQuery(since: Date, domains: Record<Platform, string[]>): SearchObject {
  const all = [...domains.zomato, ...domains.swiggy];
  // IMAP FROM is a substring match on the header; the exact domain is checked
  // again on each message (platformFromSender), so this only narrows the search.
  if (all.length === 1) return { since, from: all[0] };
  return { since, or: all.map((d) => ({ from: d })) };
}

/**
 * One downloaded email's report attachments. The platform is the one its
 * sender address belongs to, and its DMARC result was checked from the
 * envelope and headers in pass 1 (pickReportMessages), before this download.
 */
export async function readReportMessage(
  source: Uint8Array,
  platform: Platform,
  messageId: string | null,
  receivedAt: string | null,
): Promise<ScannedMessage> {
  const mail = await simpleParser(Buffer.from(source));
  const from = mail.from?.value?.[0]?.address ?? '';
  const subject = mail.subject ?? '';
  const id = messageId ?? mail.messageId ?? null;
  const attachments: ReportAttachment[] = [];
  const skipped: SkippedMessage[] = [];
  const files = mail.attachments.filter((a) => a.filename && wantsAttachment(platform, a.filename));
  if (!files.length) skipped.push({ subject, from, reason: 'no report attachment' });
  for (const a of files) {
    if (a.size > MAX_REPORT_BYTES) {
      skipped.push({ subject, from, reason: `${a.filename} is larger than ${MAX_REPORT_BYTES / 1024 / 1024} MB` });
      continue;
    }
    attachments.push({
      platform,
      fileName: a.filename as string,
      bytes: new Uint8Array(a.content),
      email: {
        messageId: id,
        from,
        subject: subject || null,
        receivedAt: receivedAt ?? (mail.date ? mail.date.toISOString() : null),
      },
    });
  }
  return { messageId: id, platform, attachments, skipped };
}

/**
 * `known`: Message-IDs already handled (a report row or the seen-messages table
 * has them) — skipped without downloading. A saved Swiggy file is re-read from
 * Storage when its parser lands, not from the mailbox.
 *
 * Emails are downloaded ONE AT A TIME and handed to `onMessage` before the next
 * is fetched, so memory holds one email, not sixty. `onMessage` answers true
 * when it finished the email and false when it stopped early (out of time). No
 * further email is started after that, or once `deadline` (ms since epoch) has
 * passed; what is left is counted in `messagesLeft`.
 */
export async function scanMailbox(
  cfg: MailboxConfig,
  onMessage: (message: ScannedMessage) => Promise<boolean>,
  opts: { lookbackDays?: number; known?: Set<string>; deadline?: number } = {},
): Promise<MailboxScan> {
  const lookbackDays = opts.lookbackDays ?? cfg.lookbackDays;
  const known = opts.known ?? new Set<string>();
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 45_000,
  });
  // A socket timeout after login is emitted as an 'error' event. With no
  // listener Node throws it as an uncaught exception, past the try/finally
  // below; with one, the command in flight fails and the catch in sync.ts
  // logs the run.
  client.on('error', (err) => console.error('online-settlements: mailbox connection error', err));

  let messagesFound = 0;
  let candidates = 0;
  let picked: MessageSummary[] = [];
  let rejected: SkippedMessage[] = [];
  let handled = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const uids = (await client.search(searchQuery(since, cfg.domains), { uid: true })) || [];
      messagesFound = uids.length;
      if (uids.length) {
        // Pass 1, cheap: envelopes, MIME structure, size and the sender-
        // authentication header only. Collect first, decide after: no other
        // IMAP command may run while a fetch streams.
        const summaries: MessageSummary[] = [];
        const peek = { uid: true, envelope: true, bodyStructure: true, size: true, headers: ['authentication-results'] };
        for await (const msg of client.fetch(uids, peek, { uid: true })) {
          summaries.push({
            uid: msg.uid,
            messageId: msg.envelope?.messageId ?? null,
            from: msg.envelope?.from?.[0]?.address ?? '',
            subject: msg.envelope?.subject ?? '',
            fileNames: partFileNames(msg.bodyStructure),
            size: msg.size ?? null,
            authResults: authResultsText(msg.headers),
          });
        }
        ({ picked, candidates, rejected } = pickReportMessages(summaries, known, cfg.domains));
      }
      // Pass 2: download only the messages that carry a report, one at a time.
      for (const m of picked) {
        if (opts.deadline !== undefined && Date.now() > opts.deadline) break;
        const msg = await client.fetchOne(String(m.uid), { uid: true, source: true, internalDate: true }, { uid: true });
        // A message gone from the mailbox since the search has nothing left to read.
        if (msg && msg.source) {
          const at = msg.internalDate ? new Date(msg.internalDate) : null;
          const receivedAt = at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
          const platform = platformFromSender(m.from, cfg.domains) as Platform;
          const scanned = await readReportMessage(msg.source, platform, m.messageId, receivedAt);
          if (!(await onMessage(scanned))) break;
        }
        handled++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
  return { messagesFound, messagesWithReports: picked.length, messagesLeft: Math.max(0, candidates - handled), skipped: rejected };
}

/** A login/connection error in words the owner can act on. */
export function friendlyMailboxError(err: unknown): string {
  const raw = err instanceof Error ? `${err.message} ${(err as { responseText?: string }).responseText ?? ''}` : String(err);
  if (/AUTHENTICATIONFAILED|invalid credentials|authentication failed|application-specific password/i.test(raw)) {
    return 'The mailbox refused the login. Check ONLINE_REPORTS_IMAP_USER and that ONLINE_REPORTS_IMAP_PASSWORD is an app password.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timeout/i.test(raw)) {
    return `Could not reach the mail server (${raw.trim().slice(0, 120)}). Check ONLINE_REPORTS_IMAP_HOST and PORT.`;
  }
  if (/mailbox doesn't exist|nonexistent|unknown mailbox|NONEXISTENT/i.test(raw)) {
    return 'That mail folder does not exist. Check ONLINE_REPORTS_IMAP_MAILBOX.';
  }
  return `Mail check failed: ${raw.trim().slice(0, 200)}`;
}
