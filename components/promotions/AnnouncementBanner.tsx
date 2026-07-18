'use client';

// Self-contained homepage banner (LOY-5/CUS-071). Fetches the currently
// active announcements itself — drop `<AnnouncementBanner />` anywhere
// (home page, menu page, etc.) with no props required. Dismissing a banner
// only hides it for the current tab session (sessionStorage), so it
// reappears on the next visit — the owner controls real expiry via
// `active`/`starts_at`/`ends_at`.

import { useEffect, useState } from 'react';
import type { Announcement } from '@/lib/types';

const DISMISSED_KEY = 'hioc:dismissed-announcements';

function readDismissed(): string[] {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/announcements', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setAnnouncements((data.announcements as Announcement[]) ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setDismissed(readDismissed());
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) return null;

  const visible = announcements.filter((a) => !dismissed.includes(a.id));
  if (visible.length === 0) return null;

  function dismiss(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      // sessionStorage unavailable (private mode etc.) — harmless to skip.
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 pt-4">
      {visible.map((a) => (
        <div
          key={a.id}
          className="mx-auto flex w-full max-w-4xl items-start gap-3 rounded-md border border-tan bg-[#f6efe9] px-4 py-3 shadow-sm"
        >
          {a.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.image_url} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
          ) : null}
          <div className="flex-1">
            <p className="text-sm font-bold text-charcoal">{a.title}</p>
            {a.body ? <p className="mt-0.5 text-sm text-muted">{a.body}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => dismiss(a.id)}
            aria-label="Dismiss announcement"
            className="shrink-0 text-lg leading-none text-muted hover:text-charcoal"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
