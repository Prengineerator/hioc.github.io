import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { INTERRUPTED, ingestSettlementFile } from '@/lib/online-settlements/ingest';
import { scanMailbox, type MailboxConfig, type ScannedMessage } from '@/lib/online-settlements/mailbox';
import { handleScannedMessage, runOnlineReportSync, SYNC_TIME_BUDGET_MS, type SyncResult } from '@/lib/online-settlements/sync';
import { memoryStore } from './helpers/memorySettlementStore';
import { buildZomatoWorkbook } from './helpers/zomatoSettlementFixture';

// The mail check end to end, with a stand-in for the IMAP server (imapflow) and
// for Supabase (the memory store, a fake admin client): one email downloaded
// and handled at a time, the connection's error event listened to, emails
// remembered once handled, the 45 s time budget, and reports a run left
// interrupted read again after the mail pass.

interface FakeMail {
  uid: number;
  raw: string;
  fetched: Record<string, unknown>;
}
const imap = vi.hoisted(() => ({
  instances: [] as { handlers: Record<string, (...args: unknown[]) => void> }[],
  mails: [] as { uid: number; raw: string; fetched: Record<string, unknown> }[],
  queries: [] as Record<string, unknown>[],
  downloads: [] as number[],
  log: [] as string[],
  failOn: null as number | null,
}));
const db = vi.hoisted(() => ({
  mem: null as null | { store: unknown; reports: { status: string; error: string | null }[] },
  reportIds: [] as string[],
  seenIds: [] as string[],
  seen: [] as Record<string, unknown>[],
  finished: [] as Record<string, unknown>[],
  onSave: null as null | (() => void),
}));

vi.mock('imapflow', () => {
  class ImapFlow {
    handlers: Record<string, (...args: unknown[]) => void> = {};
    constructor() {
      imap.instances.push(this);
    }
    on(event: string, fn: (...args: unknown[]) => void) {
      this.handlers[event] = fn;
      return this;
    }
    async connect() {
      imap.log.push('connect');
    }
    async getMailboxLock() {
      return { release: () => imap.log.push('unlock') };
    }
    async search() {
      return imap.mails.map((m) => m.uid);
    }
    async *fetch(_uids: number[], query: Record<string, unknown>) {
      imap.queries.push(query);
      for (const m of imap.mails) yield m.fetched;
    }
    async fetchOne(seq: string) {
      const uid = Number(seq);
      imap.log.push(`download ${uid}`);
      imap.downloads.push(uid);
      if (imap.failOn === uid) throw new Error('Socket timeout');
      return { uid, source: Buffer.from(imap.mails.find((m) => m.uid === uid)?.raw ?? ''), internalDate: new Date('2026-09-30T04:00:00Z') };
    }
    async logout() {
      imap.log.push('logout');
    }
    close() {
      imap.log.push('close');
    }
  }
  return { ImapFlow };
});

vi.mock('@/lib/online-settlements/store', () => ({
  supabaseSettlementStore: () => {
    const store = db.mem?.store as ReturnType<typeof memoryStore>['store'];
    return {
      ...store,
      saveFile: async (...args: Parameters<typeof store.saveFile>) => {
        db.onSave?.();
        return store.saveFile(...args);
      },
      readFile: async (path: string) => {
        imap.log.push('reread');
        return store.readFile(path);
      },
    };
  },
  loadRereadableReports: async (_admin: unknown, opts: { error?: string; limit: number }) => {
    const all = (db.mem?.reports ?? []).filter((r) => (r.status === 'failed' || r.status === 'unsupported') && (!opts.error || r.error === opts.error));
    const rows = all.slice(0, opts.limit);
    return { rows, left: all.length - rows.length };
  },
}));

// The calls sync.ts makes on the admin client, and nothing more.
const admin = {
  from: (table: string) => ({
    insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'run-1' }, error: null }) }) }),
    select: (column: string) => {
      const q = {
        not: () => q,
        order: () => q,
        range: async () => ({
          data: (table === 'online_settlement_reports' ? db.reportIds : db.seenIds).map((id) => ({ [column]: id })),
          error: null,
        }),
      };
      return q;
    },
    upsert: async (row: Record<string, unknown>) => {
      db.seen.push(row);
      return { error: null };
    },
    update: (patch: Record<string, unknown>) => ({
      eq: async () => {
        db.finished.push(patch);
        return { error: null };
      },
    }),
  }),
} as never;

const cfg: MailboxConfig = {
  host: 'imap.test',
  port: 993,
  user: 'r@test',
  pass: 'x',
  mailbox: 'INBOX',
  lookbackDays: 14,
  domains: { zomato: ['zomato.com'], swiggy: ['swiggy.in'] },
};

const FORGED = 'mx.google.com; dkim=fail; dmarc=fail (p=REJECT) header.from=zomato.com';

/** A downloadable email, and what the server says about it in the cheap first pass. */
function mail(uid: number, o: { files?: { name: string; bytes: Uint8Array }[]; named?: string[]; auth?: string; size?: number; from?: string } = {}): FakeMail {
  const files = o.files ?? [];
  const from = o.from ?? 'noreply@zomato.com';
  const parts = files
    .map(
      (f) =>
        `--B\r\nContent-Type: application/octet-stream; name="${f.name}"\r\nContent-Disposition: attachment; filename="${f.name}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${Buffer.from(f.bytes).toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n`,
    )
    .join('');
  const raw =
    `From: Zomato <${from}>\r\nTo: reports@test\r\nSubject: Report ${uid}\r\nMessage-ID: <m${uid}@zomato.com>\r\nDate: Wed, 30 Sep 2026 04:00:00 +0000\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nYour report\r\n${parts}--B--\r\n`;
  const names = o.named ?? files.map((f) => f.name);
  return {
    uid,
    raw,
    fetched: {
      uid,
      envelope: { messageId: `<m${uid}@zomato.com>`, from: [{ address: from }], subject: `Report ${uid}` },
      bodyStructure: { type: 'multipart/mixed', childNodes: names.map((n) => ({ type: 'application/octet-stream', disposition: 'attachment', dispositionParameters: { filename: n } })) },
      size: o.size ?? raw.length,
      headers: o.auth ? Buffer.from(`Authentication-Results: ${o.auth}\r\n\r\n`) : Buffer.alloc(0),
    },
  };
}

const week = (id: string) =>
  buildZomatoWorkbook({ period: '22 Sep 2026 - 28 Sep 2026', orders: [{ id, date: '2026-09-28 13:00:00', subtotal: 300, payout: 150 }] });
/** Report number n: one order, id 90000000nn. */
const file = async (n: string) => ({ name: `Zomato_Settlement_Report_${n}.xlsx`, bytes: await week(`90000000${n.padStart(2, '0')}`) });
const stockFile = async (sheetText: string) => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Sheet1').addRow([sheetText]);
  return { name: 'stock.xlsx', bytes: new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer) };
};
const noop = async () => true;

const blankResult = (): SyncResult => ({
  configured: true, ok: false, runId: 'run-1', lookbackDays: 14, messagesFound: 0, messagesLeft: 0, filesFound: 0,
  filesRead: 0, filesSkipped: 0, filesFailed: 0, error: null, files: [], skippedMessages: [],
});

beforeEach(() => {
  imap.instances = [];
  imap.mails = [];
  imap.queries = [];
  imap.downloads = [];
  imap.log = [];
  imap.failOn = null;
  db.mem = memoryStore();
  db.reportIds = [];
  db.seenIds = [];
  db.seen = [];
  db.finished = [];
  db.onSave = null;
  process.env.ONLINE_REPORTS_IMAP_USER = 'r@test';
  process.env.ONLINE_REPORTS_IMAP_PASSWORD = 'x';
});
afterEach(() => {
  delete process.env.ONLINE_REPORTS_IMAP_USER;
  delete process.env.ONLINE_REPORTS_IMAP_PASSWORD;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scanMailbox', () => {
  it('asks for size and sender authentication up front, and hands over one email before downloading the next', async () => {
    imap.mails = [
      mail(1, { files: [await file('1')], auth: FORGED }),
      mail(2, { files: [await file('2')] }),
      mail(3, { files: [await file('3')], auth: 'mx.google.com; dmarc=pass' }),
      mail(4, { files: [await file('4')] }),
      mail(5, { files: [await file('5')], size: 30 * 1024 * 1024 }),
    ];
    const seen: string[] = [];

    const scan = await scanMailbox(
      cfg,
      async (m) => {
        imap.log.push(`handled ${m.messageId}`);
        seen.push(m.attachments.map((a) => a.fileName).join());
        return true;
      },
      { known: new Set(['<m4@zomato.com>']) },
    );

    expect(imap.queries[0]).toMatchObject({ envelope: true, bodyStructure: true, size: true, headers: ['authentication-results'] });
    // Newest first; the forged, oversize and already-handled emails are never downloaded.
    expect(imap.downloads).toEqual([3, 2]);
    expect(imap.log.filter((l) => /^(download|handled)/.test(l))).toEqual(['download 3', 'handled <m3@zomato.com>', 'download 2', 'handled <m2@zomato.com>']);
    expect(seen).toEqual(['Zomato_Settlement_Report_3.xlsx', 'Zomato_Settlement_Report_2.xlsx']);
    expect(scan).toMatchObject({ messagesFound: 5, messagesWithReports: 2, messagesLeft: 0 });
    expect(scan.skipped.map((s) => s.reason)).toEqual(['failed sender authentication (DMARC): possibly forged', 'the email is larger than 25 MB']);
    expect(imap.log[imap.log.length - 1]).toBe('logout');
  });

  it('hands over the report files with the email details, and says what it left out', async () => {
    imap.mails = [mail(1, { files: [await file('1')] }), mail(2, { named: ['Zomato_Settlement_Report_2.xlsx'] })];
    const got: ScannedMessage[] = [];

    await scanMailbox(cfg, async (m) => {
      got.push(m);
      return true;
    });

    expect(got.map((m) => [m.messageId, m.platform, m.attachments.length, m.skipped.map((s) => s.reason)])).toEqual([
      ['<m2@zomato.com>', 'zomato', 0, ['no report attachment']],
      ['<m1@zomato.com>', 'zomato', 1, []],
    ]);
    expect(got[1].attachments[0]).toMatchObject({
      platform: 'zomato',
      fileName: 'Zomato_Settlement_Report_1.xlsx',
      email: { messageId: '<m1@zomato.com>', from: 'noreply@zomato.com', subject: 'Report 1', receivedAt: '2026-09-30T04:00:00.000Z' },
    });
  });

  it('listens for the connection’s error event, and still logs out when a command then fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    imap.mails = [mail(1, { files: [await file('1')] })];
    imap.failOn = 1;

    await expect(scanMailbox(cfg, noop)).rejects.toThrow('Socket timeout');

    // Without a listener, Node would throw this event as an uncaught exception.
    const listener = imap.instances[0].handlers.error;
    expect(listener).toBeTypeOf('function');
    expect(() => listener(new Error('Socket timeout'))).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(imap.log).toContain('unlock');
    expect(imap.log[imap.log.length - 1]).toBe('logout');
  });

  it('starts no new email after the deadline, or after the handler stops, and counts what is left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T03:45:00Z'));
    imap.mails = [3, 2, 1].map((uid) => mail(uid, { named: [`Zomato_Settlement_Report_${uid}.xlsx`] }));

    // The first email takes long enough to use up the budget.
    const slow = async () => {
      vi.setSystemTime(Date.now() + 50_000);
      return true;
    };
    const late = await scanMailbox(cfg, slow, { deadline: Date.now() + SYNC_TIME_BUDGET_MS });
    expect(imap.downloads).toEqual([3]);
    expect(late).toMatchObject({ messagesWithReports: 3, messagesLeft: 2 });

    // A handler that ran out of time part-way through an email: that email is not finished.
    imap.downloads = [];
    const stopped = await scanMailbox(cfg, async () => false);
    expect(imap.downloads).toEqual([3]);
    expect(stopped.messagesLeft).toBe(3);
  });
});

describe('handleScannedMessage', () => {
  const message = (attachments: ScannedMessage['attachments'], id = '<m1@zomato.com>'): ScannedMessage => ({ messageId: id, platform: 'zomato', attachments, skipped: [] });
  const attach = (f: { name: string; bytes: Uint8Array }) => ({
    platform: 'zomato' as const,
    fileName: f.name,
    bytes: f.bytes,
    email: { messageId: '<m1@zomato.com>', from: 'noreply@zomato.com', subject: 'Report 1', receivedAt: null },
  });

  it('remembers an email once its files are handled, with the best outcome among them', async () => {
    const m = memoryStore();
    const remembered: [string | null, string][] = [];
    const deps = { store: m.store, remember: async (msg: ScannedMessage, outcome: string) => void remembered.push([msg.messageId, outcome]) };
    const good = await file('1');
    const good2 = await file('2');
    const stock = await stockFile('Monthly stock count');
    const stock2 = await stockFile('Weekly rota');

    const r = blankResult();
    const handle = (files: { name: string; bytes: Uint8Array }[], id: string) => handleScannedMessage(deps, message(files.map(attach), id), r, Infinity);
    expect(await handle([good], '<a>')).toBe(true); // read
    expect(await handle([good], '<b>')).toBe(true); // the same file again
    expect(await handle([stock], '<c>')).toBe(true); // not a settlement report
    expect(await handle([good2, stock], '<d>')).toBe(true); // one new report, one failure already known
    expect(await handle([], '<e>')).toBe(true); // nothing to read in it
    expect(await handle([good, stock2], '<f>')).toBe(true); // a duplicate and a new failure

    expect(remembered).toEqual([['<a>', 'read'], ['<b>', 'duplicate'], ['<c>', 'failed'], ['<d>', 'read'], ['<e>', 'skipped'], ['<f>', 'failed']]);
    expect(r).toMatchObject({ filesFound: 7, filesRead: 2, filesSkipped: 3, filesFailed: 2 });
    expect(r.files.map((f) => f.status)).toEqual(['read', 'duplicate', 'failed', 'read', 'duplicate', 'duplicate', 'failed']);
  });

  it('stops before the file that would start after the deadline, and does not remember the email', async () => {
    const m = memoryStore();
    const remembered: string[] = [];
    const clock = [0, 10, 60, 70]; // the time at each check
    const deps = { store: m.store, remember: async (msg: ScannedMessage) => void remembered.push(msg.messageId ?? ''), now: () => clock.shift() ?? 99 };
    const files = await Promise.all(['1', '2', '3'].map(file));

    const r = blankResult();
    const finished = await handleScannedMessage(deps, message(files.map(attach)), r, 50);

    expect(finished).toBe(false);
    expect(r).toMatchObject({ filesFound: 2, filesRead: 2 });
    expect(m.reports).toHaveLength(2);
    expect(remembered).toEqual([]);
  });

  it('retries an email whose file threw, instead of remembering it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = memoryStore();
    const remembered: string[] = [];
    const down = { ...m.store, findReportByHash: async () => { throw new Error('database is down'); } };
    const deps = { store: down, remember: async (msg: ScannedMessage) => void remembered.push(msg.messageId ?? '') };

    const r = blankResult();
    expect(await handleScannedMessage(deps, message([attach(await file('1'))]), r, Infinity)).toBe(true);

    expect(r).toMatchObject({ filesFound: 1, filesFailed: 1 });
    expect(r.files[0]).toMatchObject({ status: 'failed', message: 'database is down' });
    expect(remembered).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('runOnlineReportSync', () => {
  it('skips emails a report row or the seen-messages table already has, remembers what it handles, and logs the run', async () => {
    db.reportIds = ['<m1@zomato.com>'];
    db.seenIds = ['<m2@zomato.com>'];
    imap.mails = [
      mail(1, { files: [await file('1')] }),
      mail(2, { files: [await file('2')] }),
      mail(3, { files: [await file('3')] }),
      mail(4, { named: ['Zomato_Settlement_Report_4.xlsx'] }), // turns out to carry no report
      mail(5, { files: [await file('5')], auth: FORGED }),
    ];

    const result = await runOnlineReportSync(admin, 'owner');

    expect(result).toMatchObject({ ok: true, messagesFound: 5, messagesLeft: 0, filesFound: 1, filesRead: 1, error: null });
    expect(imap.downloads).toEqual([4, 3]);
    expect(db.seen).toEqual([
      { message_id: '<m4@zomato.com>', platform: 'zomato', outcome: 'skipped' },
      { message_id: '<m3@zomato.com>', platform: 'zomato', outcome: 'read' },
    ]);
    expect(result.skippedMessages.map((s) => s.reason).sort()).toEqual(['failed sender authentication (DMARC): possibly forged', 'no report attachment']);
    expect(db.finished).toHaveLength(1);
    expect(db.finished[0]).toMatchObject({ messages_found: 5, files_found: 1, files_read: 1, files_failed: 0, error: null });
  });

  it('reads again, after the mail pass, a report an earlier run left interrupted', async () => {
    const m = db.mem as ReturnType<typeof memoryStore>;
    const bytes = await week('9000000099');
    const dying = { ...m.store, upsertOrders: async () => { throw new Error('killed'); } };
    await expect(ingestSettlementFile(dying, { bytes, fileName: 'Zomato_Settlement_Report_99.xlsx', source: 'email', platformHint: 'zomato' })).rejects.toThrow('killed');
    expect(m.reports[0]).toMatchObject({ status: 'failed', error: INTERRUPTED });
    imap.mails = [mail(7, { files: [await file('7')] })];

    const result = await runOnlineReportSync(admin, 'cron');

    expect(m.reports[0]).toMatchObject({ status: 'read', error: null, orders_count: 1 });
    expect(m.orders.has('zomato|9000000099')).toBe(true);
    expect(result).toMatchObject({ ok: true, filesFound: 2, filesRead: 2, filesFailed: 0, messagesLeft: 0 });
    expect(result.files.map((f) => f.fileName)).toEqual(['Zomato_Settlement_Report_7.xlsx', 'Zomato_Settlement_Report_99.xlsx']);
    // The saved file is read back only after the mailbox is closed.
    expect(imap.log.indexOf('logout')).toBeGreaterThan(-1);
    expect(imap.log.indexOf('reread')).toBeGreaterThan(imap.log.indexOf('logout'));
  });

  it('leaves other failed reports alone, and reads interrupted ones even when the mailbox cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = db.mem as ReturnType<typeof memoryStore>;
    const dying = { ...m.store, upsertOrders: async () => { throw new Error('killed'); } };
    await expect(ingestSettlementFile(dying, { bytes: await week('9000000099'), fileName: 'a.xlsx', source: 'upload', platformHint: 'zomato' })).rejects.toThrow('killed');
    const other = new ExcelJS.Workbook();
    other.addWorksheet('Sheet1').addRow(['Monthly stock count']);
    await ingestSettlementFile(m.store, { bytes: new Uint8Array((await other.xlsx.writeBuffer()) as ArrayBuffer), fileName: 'stock.xlsx', source: 'upload', platformHint: 'zomato' });
    imap.mails = [mail(1, { files: [await file('1')] })];
    imap.failOn = 1;

    const result = await runOnlineReportSync(admin, 'cron');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Mail check failed: Socket timeout|Could not reach the mail server/);
    expect(m.reports.map((r) => r.status)).toEqual(['read', 'failed']);
    expect(m.reports[1].error).toMatch(/Order Level/);
    expect(result).toMatchObject({ filesRead: 1, filesFailed: 0 });
  });

  it('starts nothing new after 45 seconds, counts the rest as left, and keeps the log true', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T03:45:00Z'));
    const m = db.mem as ReturnType<typeof memoryStore>;
    const dying = { ...m.store, upsertOrders: async () => { throw new Error('killed'); } };
    await expect(ingestSettlementFile(dying, { bytes: await week('9000000099'), fileName: 'a.xlsx', source: 'upload', platformHint: 'zomato' })).rejects.toThrow('killed');
    imap.mails = [3, 2, 1].map((uid) => mail(uid, { named: [`Zomato_Settlement_Report_${uid}.xlsx`] }));
    imap.mails[0] = mail(3, { files: [await file('3'), await file('4')] });
    // Saving the first file of the first email takes the whole budget.
    db.onSave = () => {
      vi.setSystemTime(Date.now() + SYNC_TIME_BUDGET_MS + 1000);
      db.onSave = null;
    };

    const result = await runOnlineReportSync(admin, 'cron');

    expect(SYNC_TIME_BUDGET_MS).toBe(45_000);
    expect(imap.downloads).toEqual([3]);
    // One file read, the second of the same email not started: that email is not remembered, so it is taken again.
    expect(result).toMatchObject({ ok: true, messagesFound: 3, filesFound: 1, filesRead: 1, filesFailed: 0 });
    expect(db.seen).toEqual([]);
    // 3 emails not finished + the interrupted report not reached.
    expect(result.messagesLeft).toBe(4);
    expect(m.reports[0]).toMatchObject({ status: 'failed', error: INTERRUPTED });
    expect(db.finished[0]).toMatchObject({ files_found: 1, files_read: 1 });
  });
});
