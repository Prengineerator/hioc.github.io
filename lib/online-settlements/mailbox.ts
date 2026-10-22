import 'server-only';
import { ImapFlow, type MessageStructureObject, type SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  failedAuthentication,
  MAX_REPORT_BYTES,
  platformFromSender,
  senderDomainsFromEnv,
  wantsAttachment,
} from './detect';
import type { Platform } from './types';

// Reads the café's mailbox over IMAP for the platforms' settlement emails and
// returns their report attachments. Read-only: it never marks, moves or
// deletes a message, so the owner's inbox looks exactly as before. Whether a
// file was already read is decided later by its hash (ingest.ts), not by
// email flags, so looking back over the same days every morning is safe.
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

export interface MailboxScan {
  /** Every message from a platform domain in the look-back window. */
  messagesFound: number;
  /** Of those, not yet read and carrying a report attachment: the ones downloaded. */
  messagesWithReports: number;
  /** Report-carrying messages left for the next run (over MAX_MESSAGES_PER_RUN). */
  messagesLeft: number;
  attachments: ReportAttachment[];
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
  fileNames: string[];
}

/**
 * The messages worth downloading, from their envelopes and MIME structure
 * alone (cheap: no bodies): from a trusted domain, not already processed (a
 * report row carries its Message-ID), and with an attachment that platform's
 * reports come as. Newest first, capped, so a backfill makes progress every
 * run instead of re-reading the same newest emails — and the platforms'
 * promotional mail, which has no report attached, is never downloaded.
 */
export function pickReportMessages(
  messages: MessageSummary[],
  known: Set<string>,
  domains: Record<Platform, string[]>,
  max: number = MAX_MESSAGES_PER_RUN,
): { picked: MessageSummary[]; candidates: number } {
  const candidates = messages.filter((m) => {
    const platform = platformFromSender(m.from, domains);
    if (!platform) return false;
    if (m.messageId && known.has(m.messageId)) return false;
    return m.fileNames.some((f) => wantsAttachment(platform, f));
  });
  const newestFirst = [...candidates].sort((a, b) => b.uid - a.uid);
  return { picked: newestFirst.slice(0, max), candidates: candidates.length };
}

/** The IMAP search: since the look-back date, from any trusted domain. */
export function searchQuery(since: Date, domains: Record<Platform, string[]>): SearchObject {
  const all = [...domains.zomato, ...domains.swiggy];
  // IMAP FROM is a substring match on the header; the exact domain is checked
  // again on each message (platformFromSender), so this only narrows the search.
  if (all.length === 1) return { since, from: all[0] };
  return { since, or: all.map((d) => ({ from: d })) };
}

function headerText(v: unknown): string | string[] | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  return null;
}

/**
 * `known`: Message-IDs already turned into a report row (read, saved or
 * failed) — skipped without downloading. A saved Swiggy file is re-read from
 * Storage when its parser lands, not from the mailbox.
 */
export async function scanMailbox(
  cfg: MailboxConfig,
  lookbackDays: number = cfg.lookbackDays,
  known: Set<string> = new Set(),
): Promise<MailboxScan> {
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

  const sources: { source: Buffer; receivedAt: string | null }[] = [];
  let messagesFound = 0;
  let candidates = 0;
  let picked: MessageSummary[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const uids = (await client.search(searchQuery(since, cfg.domains), { uid: true })) || [];
      messagesFound = uids.length;
      if (uids.length) {
        // Pass 1, cheap: envelopes and MIME structure only. Collect first,
        // decide after: no other IMAP command may run while a fetch streams.
        const summaries: MessageSummary[] = [];
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
          summaries.push({
            uid: msg.uid,
            messageId: msg.envelope?.messageId ?? null,
            from: msg.envelope?.from?.[0]?.address ?? '',
            fileNames: partFileNames(msg.bodyStructure),
          });
        }
        ({ picked, candidates } = pickReportMessages(summaries, known, cfg.domains));
      }
      if (picked.length) {
        // Pass 2: download only the messages that carry a report.
        const uidList = picked.map((m) => m.uid);
        for await (const msg of client.fetch(uidList, { uid: true, source: true, internalDate: true }, { uid: true })) {
          if (!msg.source) continue;
          const at = msg.internalDate ? new Date(msg.internalDate) : null;
          sources.push({ source: msg.source, receivedAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }

  const attachments: ReportAttachment[] = [];
  const skipped: SkippedMessage[] = [];
  for (const { source, receivedAt } of sources) {
    const mail = await simpleParser(source);
    const from = mail.from?.value?.[0]?.address ?? '';
    const subject = mail.subject ?? '';
    const platform = platformFromSender(from, cfg.domains);
    if (!platform) {
      skipped.push({ subject, from, reason: 'not from a Zomato or Swiggy address' });
      continue;
    }
    if (failedAuthentication(headerText(mail.headers.get('authentication-results')))) {
      skipped.push({ subject, from, reason: 'failed sender authentication (DMARC): possibly forged' });
      continue;
    }
    const files = mail.attachments.filter((a) => a.filename && wantsAttachment(platform, a.filename));
    if (!files.length) {
      skipped.push({ subject, from, reason: 'no report attachment' });
      continue;
    }
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
          messageId: mail.messageId ?? null,
          from,
          subject: subject || null,
          receivedAt: receivedAt ?? (mail.date ? mail.date.toISOString() : null),
        },
      });
    }
  }
  return {
    messagesFound,
    messagesWithReports: picked.length,
    messagesLeft: Math.max(0, candidates - picked.length),
    attachments,
    skipped,
  };
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
