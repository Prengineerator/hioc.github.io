'use client';

// Owner → Shop orders: the online offer. On/off, and the price for each number
// of jars (the introductory offer starts as 1 for ₹399 · 2 for ₹599 · 3 for
// ₹749). New checkouts use it at once; placed orders keep what they paid.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { describeOfferTiers, normalizeOfferTiers } from '@/lib/shop/pricing';
import type { ShopSettingsRow } from '@/lib/shop/server';

export function ShopOfferSettings({ settings }: { settings: ShopSettingsRow }) {
  const router = useRouter();
  const [active, setActive] = useState(settings.offer_active);
  const [name, setName] = useState(settings.offer_name);
  const [tiers, setTiers] = useState<string[]>(settings.offer_tier_prices.map(String));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(patch: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/owner/shop/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'Could not save' });
        return false;
      }
      setMessage({ ok: true, text: done });
      router.refresh();
      return true;
    } catch {
      setMessage({ ok: false, text: 'Network error — please try again.' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function toggle(next: boolean) {
    setActive(next);
    const ok = await save({ offer_active: next }, next ? 'Offer is on for new orders.' : 'Offer is off: jars are full price.');
    if (!ok) setActive(!next);
  }

  async function saveTiers(e: React.FormEvent) {
    e.preventDefault();
    const clean = normalizeOfferTiers(tiers.filter((t) => t.trim() !== ''));
    if (!clean) {
      setMessage({ ok: false, text: 'Each price must be whole rupees and more than the one before.' });
      return;
    }
    if (await save({ offer_name: name, offer_tier_prices: clean }, 'Saved.')) setEditing(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-semibold text-charcoal">{settings.offer_name}</p>
          <p className="text-xs text-muted">{describeOfferTiers(settings.offer_tier_prices)}</p>
        </div>
        <div className={busy ? 'opacity-50' : ''}>
          <ToggleSwitch checked={active} onChange={(next) => void toggle(next)} label="Online offer on" />
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">
        {active ? 'On — any flavours; more jars are priced as full groups plus the rest.' : 'Off — every jar is full price.'}
      </p>

      {editing ? (
        <form onSubmit={saveTiers} className="mt-3 space-y-3">
          <Input label="Offer name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          <div className="grid grid-cols-3 gap-2">
            {tiers.map((t, i) => (
              <Input
                key={i}
                label={`${i + 1} ${i === 0 ? 'jar' : 'jars'} (₹)`}
                inputMode="numeric"
                value={t}
                onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? e.target.value.replace(/\D/g, '') : x)))}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {tiers.length < 6 ? (
              <Button size="sm" variant="ghost" onClick={() => setTiers([...tiers, ''])} disabled={busy}>
                + Add a jar count
              </Button>
            ) : null}
            {tiers.length > 2 ? (
              <Button size="sm" variant="ghost" onClick={() => setTiers(tiers.slice(0, -1))} disabled={busy}>
                − Remove the last
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={busy}>
              Save prices
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setName(settings.offer_name);
                setTiers(settings.offer_tier_prices.map(String));
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setEditing(true)} className="mt-2 text-xs font-semibold text-tan-dark underline">
          Change prices
        </button>
      )}

      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className={`mt-2 text-sm font-semibold ${message.ok ? 'text-green-800' : 'text-red-700'}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
