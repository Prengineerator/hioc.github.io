'use client';

// "My reports" on Owner → Reports → Items & custom: the owner's own report
// setups, saved by name and opened again with one tap ("Coffee by hour",
// "Weekend best sellers"). A view keeps the setup — rows, split, filters,
// sort — but not the dates, so it always opens on the dates being looked at.
//
// Kept in this browser (localStorage): nothing to set up, and a setup is not
// sensitive. The page's URL is the setup too, so a view can also be
// bookmarked or sent, and the "Copy link" button does that.

import { useEffect, useState } from 'react';
import { SurfaceLink as Link, useSurfaceHref } from '@/components/SurfaceLink';

const STORAGE_KEY = 'hioc.owner.reportViews.v1';
const MAX_VIEWS = 20;

interface SavedView {
  name: string;
  /** The setup as URL parameters, without from/to. */
  params: string;
}

function readViews(): SavedView[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (v): v is SavedView =>
            v !== null && typeof v === 'object' && typeof (v as SavedView).name === 'string' && typeof (v as SavedView).params === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function writeViews(views: SavedView[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views.slice(0, MAX_VIEWS)));
  } catch {
    // Private mode / storage full: the views just aren't kept.
  }
}

export function SavedReportViews({ params, from, to }: { params: string; from: string; to: string }) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const toHref = useSurfaceHref();

  useEffect(() => {
    setViews(readViews());
  }, []);

  const hrefFor = (p: string) => `/owner/reports/sales?from=${from}&to=${to}${p ? `&${p}` : ''}`;

  function save() {
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return;
    // Same name replaces; newest first.
    const next = [{ name: trimmed, params }, ...views.filter((v) => v.name !== trimmed)];
    setViews(next);
    writeViews(next);
    setNaming(false);
    setName('');
  }

  function remove(n: string) {
    const next = views.filter((v) => v.name !== n);
    setViews(next);
    writeViews(next);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(new URL(toHref(hrefFor(params)), window.location.href).toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the address bar has the same link */
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-muted">My reports</span>
        {views.length === 0 ? <span className="text-xs text-muted">None saved yet.</span> : null}
        {views.map((v) => (
          <span key={v.name} className="inline-flex items-center rounded-full border border-line bg-white text-xs font-semibold">
            <Link
              href={hrefFor(v.params)}
              className={'rounded-l-full px-3 py-1.5 ' + (v.params === params ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-surface')}
            >
              {v.name}
            </Link>
            <button
              type="button"
              onClick={() => remove(v.name)}
              aria-label={`Delete saved report ${v.name}`}
              className="rounded-r-full px-2 py-1.5 text-muted hover:text-red-700"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {naming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder="Name this report"
              aria-label="Report name"
              className="min-h-[36px] rounded-md border border-line px-3 text-sm"
            />
            <button type="submit" className="min-h-[36px] rounded-md bg-charcoal px-3 text-sm font-bold text-cream">
              Save
            </button>
            <button type="button" onClick={() => setNaming(false)} className="min-h-[36px] px-2 text-sm text-muted">
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="min-h-[36px] rounded-md border border-line bg-white px-3 text-sm font-bold text-charcoal hover:border-charcoal"
          >
            + Save this report
          </button>
        )}
        <button
          type="button"
          onClick={copyLink}
          className="min-h-[36px] rounded-md border border-line bg-white px-3 text-sm font-bold text-charcoal hover:border-charcoal"
        >
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}
