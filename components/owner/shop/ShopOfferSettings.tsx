'use client';

// Owner → Shop orders: the online offer. On/off, and the price for each number
// of jars (the introductory offer starts as 1 for ₹399 · 2 for ₹599 · 3 for
// ₹749). New checkouts use it at once; placed orders keep what they paid.
//
// v2 (docs/SHOP-V2-SPEC.md E2, E2a, E5): the introductory offer now applies once
// per customer (their first paid shop order). Later offers are coupons made in
// Owner → Promotions with "Where it works: Shop". This panel also holds the
// shipping fee, the free-shipping minimum (goods after discounts) and the most
// of an order's goods Beanies can pay for on a repeat order.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { DEFAULT_SHOP_SETTINGS, describeOfferTiers, normalizeOfferTiers } from '@/lib/shop/pricing';
import type { ShopSettingsRow } from '@/lib/shop/server';

export function ShopOfferSettings({ settings }: { settings: ShopSettingsRow }) {
  const router = useRouter();
  const [active, setActive] = useState(settings.offer_active);
  const [name, setName] = useState(settings.offer_name);
  const [tiers, setTiers] = useState<string[]>(settings.offer_tier_prices.map(String));
  const [editing, setEditing] = useState(false);
  const [shipFee, setShipFee] = useState(String(settings.shipping_fee_inr ?? DEFAULT_SHOP_SETTINGS.shipping_fee_inr));
  const [freeMin, setFreeMin] = useState(String(settings.free_shipping_min_inr ?? DEFAULT_SHOP_SETTINGS.free_shipping_min_inr));
  const [beaniesPct, setBeaniesPct] = useState(String(settings.beanies_max_redeem_pct ?? DEFAULT_SHOP_SETTINGS.beanies_max_redeem_pct));
  const [errors, setErrors] = useState<{
    fee?: string;
    min?: string;
    pct?: string;
  }>({});
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
      setMessage({
        ok: false,
        text: 'Each price must be whole rupees and more than the one before.',
      });
      return;
    }
    if (await save({ offer_name: name, offer_tier_prices: clean }, 'Saved.')) setEditing(false);
  }

  const savedFee = String(settings.shipping_fee_inr ?? DEFAULT_SHOP_SETTINGS.shipping_fee_inr);
  const savedMin = String(settings.free_shipping_min_inr ?? DEFAULT_SHOP_SETTINGS.free_shipping_min_inr);
  const savedPct = String(settings.beanies_max_redeem_pct ?? DEFAULT_SHOP_SETTINGS.beanies_max_redeem_pct);
  const rulesDirty = shipFee !== savedFee || freeMin !== savedMin || beaniesPct !== savedPct;

  async function saveRules(e: React.FormEvent) {
    e.preventDefault();
    const next: { fee?: string; min?: string; pct?: string } = {};
    const whole = (v: string) => /^\d+$/.test(v.trim());
    if (!whole(shipFee) || Number(shipFee) > 500) next.fee = 'Whole rupees, ₹0 to ₹500';
    if (!whole(freeMin) || Number(freeMin) > 100000) next.min = 'Whole rupees, ₹0 to ₹1,00,000';
    if (!whole(beaniesPct) || Number(beaniesPct) > 50) next.pct = 'A whole percent, 0 to 50';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    await save(
      {
        shipping_fee_inr: Number(shipFee),
        free_shipping_min_inr: Number(freeMin),
        beanies_max_redeem_pct: Number(beaniesPct),
      },
      'Shipping and Beanies saved for new orders.',
    );
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

      <p className="mt-3 rounded-md bg-surface px-3 py-2 text-xs text-charcoal">
        The introductory offer now applies <strong>once per customer</strong>, on their first paid shop order. For later offers, make a
        coupon in{' '}
        <Link href="/owner/promotions" className="font-semibold text-tan-dark underline">
          Owner → Promotions
        </Link>{' '}
        and set <strong>Where it works: Shop</strong>.
      </p>

      <form onSubmit={saveRules} noValidate className="mt-4 space-y-3 border-t border-line pt-3">
        <h3 className="text-sm font-bold text-charcoal">Shipping and Beanies</h3>
        <Input
          label="Shipping fee (₹)"
          inputMode="numeric"
          autoComplete="off"
          className="font-mono tabular-nums"
          value={shipFee}
          onChange={(e) => setShipFee(e.target.value.replace(/\D/g, ''))}
          error={errors.fee}
          hint="Charged on orders below the free-shipping amount."
        />
        <Input
          label="Free shipping from (₹ goods after discounts)"
          inputMode="numeric"
          autoComplete="off"
          className="font-mono tabular-nums"
          value={freeMin}
          onChange={(e) => setFreeMin(e.target.value.replace(/\D/g, ''))}
          error={errors.min}
          hint="Goods after offers, coupons and Beanies, shipping not counted."
        />
        <Input
          label="Beanies on repeat orders (max %)"
          inputMode="numeric"
          autoComplete="off"
          className="font-mono tabular-nums"
          value={beaniesPct}
          onChange={(e) => setBeaniesPct(e.target.value.replace(/\D/g, ''))}
          error={errors.pct}
          hint="The most of an order's goods Beanies can pay for, 0 to 50. Not on a customer's first order. 0 turns it off."
        />
        {rulesDirty ? (
          <Button type="submit" size="sm" variant="secondary" loading={busy}>
            Save shipping and Beanies
          </Button>
        ) : null}
      </form>

      <div aria-live="polite">
        {message ? (
          <p
            role={message.ok ? 'status' : 'alert'}
            className={`mt-2 text-sm font-semibold ${message.ok ? 'text-green-800' : 'text-red-700'}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
