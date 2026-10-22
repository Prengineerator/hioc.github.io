'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// The ways a report gets onto Owner → Online orders by hand: "Check email
// now" (the daily mail check, on demand, optionally further back), "Upload a
// report" (a file saved from the email or the partner dashboard) and, while
// some saved files are unread, "Re-read saved reports" (run them through the
// reader again once a parser has improved). Each answers with a one-line
// summary and refreshes the server page.

type SyncFile = { fileName: string; status: string; platform: string | null; periodStart?: string | null; periodEnd?: string | null; message?: string };
type SyncResult = { messagesFound: number; messagesLeft: number; filesFound: number; filesRead: number; filesSkipped: number; filesFailed: number; files: SyncFile[] };

type RereadResult = { checked: number; read: number; stillUnsupported: number; failed: number; missingFile: number };

const LOOKBACKS = [
  { days: 14, label: 'last 2 weeks' },
  { days: 45, label: 'last 6 weeks' },
  { days: 200, label: 'last 6 months' },
  { days: 400, label: 'last 13 months' },
];

function syncSummary(r: SyncResult): string {
  if (r.messagesFound === 0) return 'No Zomato or Swiggy emails found in that period.';
  const parts = [`${r.messagesFound} email${r.messagesFound === 1 ? '' : 's'} found`];
  if (r.filesRead) parts.push(`${r.filesRead} new report${r.filesRead === 1 ? '' : 's'} read`);
  if (r.filesSkipped) parts.push(`${r.filesSkipped} already read`);
  const saved = r.files.filter((f) => f.status === 'unsupported').length;
  if (saved) parts.push(`${saved} Swiggy file${saved === 1 ? '' : 's'} saved but not read (not the weekly payout report)`);
  if (r.filesFailed) parts.push(`${r.filesFailed} could not be read`);
  if (!r.filesFound && !r.messagesLeft) parts.push('no new reports');
  const more = r.messagesLeft ? ` ${r.messagesLeft} more report email${r.messagesLeft === 1 ? '' : 's'} to go: press Check email now again.` : '';
  return parts.join(' · ') + '.' + more;
}

function rereadSummary(r: RereadResult, left: number): string {
  if (r.checked === 0) return 'No saved reports waiting to be read.';
  const parts: string[] = [];
  if (r.read) parts.push(`${r.read} report${r.read === 1 ? '' : 's'} read`);
  if (r.stillUnsupported) parts.push(`${r.stillUnsupported} Swiggy file${r.stillUnsupported === 1 ? '' : 's'} still not the weekly payout report`);
  if (r.failed) parts.push(`${r.failed} could not be read`);
  if (r.missingFile) parts.push(`${r.missingFile} file${r.missingFile === 1 ? '' : 's'} not found in storage`);
  const more = left ? ` ${left} more to go: press Re-read saved reports again.` : '';
  return parts.join(' · ') + '.' + more;
}

export function OnlineReportActions({ configured, rereadable }: { configured: boolean; rereadable: number }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [lookback, setLookback] = useState(14);
  const [platform, setPlatform] = useState('');
  // Where the last "Re-read saved reports" stopped, when it left some for another press.
  const rereadAfter = useRef<string | null>(null);
  const [busy, setBusy] = useState<'sync' | 'upload' | 'reread' | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function checkEmail() {
    setBusy('sync');
    setMessage(null);
    try {
      const res = await fetch('/api/owner/online-reports/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lookbackDays: lookback }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: 'error', text: body.error ?? 'Mail check failed.' });
      } else {
        setMessage({ tone: 'ok', text: syncSummary(body.result as SyncResult) });
        router.refresh();
      }
    } catch {
      setMessage({ tone: 'error', text: 'Could not reach the server. Check your connection and try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setBusy('upload');
    setMessage(null);
    const form = new FormData();
    form.append('file', file);
    if (platform) form.append('platform', platform);
    try {
      const res = await fetch('/api/owner/online-reports/upload', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: 'error', text: body.error ?? 'Upload failed.' });
      } else {
        const o = body.outcome as { status: string; orders?: number; periodStart?: string | null; periodEnd?: string | null };
        const text =
          o.status === 'read'
            ? `Read ${o.orders ?? 0} orders${o.periodStart && o.periodEnd ? ` for ${o.periodStart} to ${o.periodEnd}` : ''}.`
            : o.status === 'duplicate'
              ? 'This report was already read.'
              : "Saved, but this isn't Swiggy's weekly payout report (the .xlsx annexure), so it was not read.";
        setMessage({ tone: 'ok', text });
        router.refresh();
      }
    } catch {
      setMessage({ tone: 'error', text: 'Could not reach the server. Check your connection and try again.' });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function rereadSaved() {
    setBusy('reread');
    setMessage(null);
    try {
      const res = await fetch('/api/owner/online-reports/reprocess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ after: rereadAfter.current }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: 'error', text: body.error ?? 'Could not re-read the saved reports.' });
      } else {
        rereadAfter.current = body.next ?? null;
        setMessage({ tone: 'ok', text: rereadSummary(body.result as RereadResult, Number(body.left) || 0) });
        router.refresh();
      }
    } catch {
      setMessage({ tone: 'error', text: 'Could not reach the server. Check your connection and try again.' });
    } finally {
      setBusy(null);
    }
  }

  const button =
    'rounded-md border border-line bg-white px-3 py-1.5 text-xs font-bold text-charcoal hover:border-charcoal disabled:opacity-50';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} onClick={checkEmail} disabled={!configured || busy !== null}>
          {busy === 'sync' ? 'Checking email…' : 'Check email now'}
        </button>
        <label className="flex items-center gap-1 text-xs text-muted" htmlFor="online-lookback">
          for the
          <select
            id="online-lookback"
            className="rounded-md border border-line bg-white p-1 text-xs text-charcoal"
            value={lookback}
            onChange={(e) => setLookback(Number(e.target.value))}
            disabled={!configured || busy !== null}
          >
            {LOOKBACKS.map((l) => (
              <option key={l.days} value={l.days}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <span className="mx-1 hidden h-5 w-px bg-line sm:inline-block" aria-hidden="true" />
        <label className="flex items-center gap-1 text-xs text-muted" htmlFor="online-upload-platform">
          Upload a
          <select
            id="online-upload-platform"
            className="rounded-md border border-line bg-white p-1 text-xs text-charcoal"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            disabled={busy !== null}
          >
            <option value="">Zomato or Swiggy</option>
            <option value="zomato">Zomato</option>
            <option value="swiggy">Swiggy</option>
          </select>
          report
        </label>
        <button type="button" className={button} onClick={() => fileRef.current?.click()} disabled={busy !== null}>
          {busy === 'upload' ? 'Uploading…' : 'Choose file'}
        </button>
        <input
          ref={fileRef}
          id="online-upload-file"
          type="file"
          accept=".xlsx,.xls,.csv,.zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        {rereadable > 0 ? (
          <>
            <span className="mx-1 hidden h-5 w-px bg-line sm:inline-block" aria-hidden="true" />
            <button
              type="button"
              className={button}
              onClick={rereadSaved}
              disabled={busy !== null}
              title="Run the report files already saved here through the reader again, without the email"
            >
              {busy === 'reread' ? 'Re-reading…' : 'Re-read saved reports'}
            </button>
          </>
        ) : null}
      </div>
      {message ? (
        <p role="status" className={'text-sm ' + (message.tone === 'ok' ? 'text-green-800' : 'text-red-700')}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
