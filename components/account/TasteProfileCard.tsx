'use client';

// /account "Your taste profile" card (§5.5). Talks to GET/DELETE/PATCH
// /api/account/taste-profile. Hides itself entirely on 404/401/500 or any
// network failure — a customer who isn't signed in, whose account has no
// profile yet, or who hits a server hiccup should just not see this card
// rather than see an error.

import { useEffect, useState } from 'react';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { TasteProfile } from '@/lib/suggest/types';

interface TasteProfileApiResponse {
  profile: TasteProfile | null;
  optedOut: boolean;
  summary: string;
}

export function TasteProfileCard() {
  const [data, setData] = useState<TasteProfileApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/account/taste-profile', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((json: TasteProfileApiResponse) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setHidden(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleReset() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch('/api/account/taste-profile', { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      setData((prev) =>
        prev
          ? {
              ...prev,
              profile: null,
              summary: "We'll start noticing your usual again from your next order.",
            }
          : prev,
      );
    } catch {
      setActionError("That didn't go through — please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleOptOut(nextOptedOut: boolean) {
    if (!data) return;
    setBusy(true);
    setActionError(null);
    const previous = data;
    setData({ ...data, optedOut: nextOptedOut });
    try {
      const res = await fetch('/api/account/taste-profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optedOut: nextOptedOut }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setData(previous);
      setActionError("That didn't go through — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (hidden || loading || !data) return null;

  return (
    <div className="rounded-md border border-line bg-cream p-5 shadow-card">
      <h2 className="font-semibold text-charcoal">Your taste profile</h2>
      <p className="mt-1 text-sm text-muted">
        {data.summary || "We don't have enough orders yet to notice a pattern — that's alright."}
      </p>

      {actionError ? <p className="mt-2 text-sm text-red-700">{actionError}</p> : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={handleReset}
          disabled={busy}
          className="min-h-[44px] rounded-md border border-line px-4 text-sm font-semibold text-charcoal transition-colors hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset
        </button>
        <label className="flex items-center gap-2 text-sm font-semibold text-charcoal">
          Don&apos;t personalise
          <ToggleSwitch
            checked={data.optedOut}
            onChange={handleToggleOptOut}
            label="Don't personalise my suggestions"
          />
        </label>
      </div>
    </div>
  );
}
