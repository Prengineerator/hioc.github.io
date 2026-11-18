'use client';

// Owner → Shop orders: the Products card (docs/SHOP-V2-SPEC.md E1). It replaces
// the old "Flavours in stock" switches. Products are grouped by line (Instant
// Coffee, Home Blend). For each one the owner can:
//   - switch it Listed / In stock: these save at once (optimistic, and rolled
//     back with the server's reason if refused);
//   - edit the price (whole ₹), the packed weight (kg) and a one-line
//     description, with a Save button that appears only while one is changed.
// The server validates everything (PATCH /api/owner/shop/products/[id]); its
// message shows under the row it belongs to. A product still at the placeholder
// price is hidden from customers and can't be listed until it has a real price:
// the card says so, and the Listed switch shows the server's refusal.
// Changing a price never touches orders already placed (their lines are frozen).

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { PLACEHOLDER_PRICE_INR, PRODUCT_LINES } from '@/lib/shop/catalog';
import type { ShopProduct, ShopProductLine } from '@/lib/shop/types';

const DESCRIPTION_MAX = 160;
const LINE_ORDER: ShopProductLine[] = ['instant', 'home_blend'];

interface Saved {
  price_inr: number;
  listed: boolean;
  in_stock: boolean;
  ship_weight_kg: number;
  description: string;
}

function savedOf(p: ShopProduct): Saved {
  return {
    price_inr: Number(p.price_inr),
    listed: p.listed,
    in_stock: p.in_stock,
    ship_weight_kg: Number(p.ship_weight_kg),
    description: p.description ?? '',
  };
}

const isPlaceholder = (price: number) => price <= PLACEHOLDER_PRICE_INR;
const priceText = (price: number) => (isPlaceholder(price) ? '' : String(price));
const weightText = (kg: number) => String(Number.isFinite(kg) ? kg : '');

function ProductRow({ product }: { product: ShopProduct }) {
  const router = useRouter();
  const [saved, setSaved] = useState<Saved>(() => savedOf(product));
  const [price, setPrice] = useState(() => priceText(saved.price_inr));
  const [weight, setWeight] = useState(() => weightText(saved.ship_weight_kg));
  const [description, setDescription] = useState(saved.description);
  const [busy, setBusy] = useState(false);
  // Synchronous in-flight guard: state alone is stale within one render.
  const inFlight = useRef(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    price?: string;
    weight?: string;
  }>({});

  const dirty = price !== priceText(saved.price_inr) || weight !== weightText(saved.ship_weight_kg) || description !== saved.description;
  const hidden = isPlaceholder(saved.price_inr);

  async function patch(body: Record<string, unknown>): Promise<Saved | null> {
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/owner/shop/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        product?: Partial<Saved>;
      };
      if (!res.ok || !data.product) {
        setMessage({
          ok: false,
          text: data.error ?? `Could not save (HTTP ${res.status}).`,
        });
        return null;
      }
      const p = data.product;
      const next: Saved = {
        price_inr: p.price_inr !== undefined ? Number(p.price_inr) : ((body.price_inr as number | undefined) ?? saved.price_inr),
        listed: p.listed ?? (body.listed as boolean | undefined) ?? saved.listed,
        in_stock: p.in_stock ?? (body.in_stock as boolean | undefined) ?? saved.in_stock,
        ship_weight_kg:
          p.ship_weight_kg !== undefined ? Number(p.ship_weight_kg) : ((body.ship_weight_kg as number | undefined) ?? saved.ship_weight_kg),
        description: p.description ?? (body.description as string | undefined) ?? saved.description,
      };
      setSaved(next);
      router.refresh();
      return next;
    } catch {
      setMessage({ ok: false, text: 'Network error — please try again.' });
      return null;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // Optimistic: flip at once, put it back (with the reason) if the server says no.
  async function toggle(key: 'listed' | 'in_stock', next: boolean) {
    if (inFlight.current) return;
    const before = saved;
    setSaved({ ...saved, [key]: next });
    const done = await patch({ [key]: next });
    if (done) {
      setMessage({
        ok: true,
        text:
          key === 'listed'
            ? next
              ? 'Listed: customers can see it.'
              : 'Unlisted: hidden from customers.'
            : next
              ? 'Back in stock.'
              : 'Marked out of stock.',
      });
    } else {
      setSaved(before);
    }
  }

  async function saveFields(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const errors: { price?: string; weight?: string } = {};
    const body: Record<string, unknown> = {};
    if (price !== priceText(saved.price_inr)) {
      if (!/^\d+$/.test(price.trim())) errors.price = 'Enter whole rupees, e.g. 899';
      else body.price_inr = Number(price);
    }
    if (weight !== weightText(saved.ship_weight_kg)) {
      const w = Number(weight);
      if (weight.trim() === '' || !Number.isFinite(w)) errors.weight = 'Enter the packed weight in kg, e.g. 0.55';
      else body.ship_weight_kg = w;
    }
    if (description !== saved.description) body.description = description;
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const done = await patch(body);
    if (done) {
      setPrice(priceText(done.price_inr));
      setWeight(weightText(done.ship_weight_kg));
      setDescription(done.description);
      setMessage({
        ok: true,
        text: 'Saved. Orders already placed keep their price.',
      });
    }
  }

  const name = product.display_name || product.name;
  const status = saved.listed ? (saved.in_stock ? 'Listed · in stock' : 'Listed · out of stock') : 'Not listed';

  return (
    <li className="py-4 first:pt-2">
      <form onSubmit={saveFields} noValidate aria-label={`${name} settings`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-charcoal">{name}</p>
            <p className="font-mono text-xs tabular-nums text-muted">{product.sku}</p>
          </div>
          {hidden ? (
            <Badge variant="outline" className="border-amber-600 text-amber-800">
              <span aria-hidden="true">⚠</span> Hidden until you set a price and list it
            </Badge>
          ) : (
            <Badge variant={saved.listed && saved.in_stock ? 'success' : 'neutral'}>
              <span aria-hidden="true">{saved.listed && saved.in_stock ? '✓' : '•'}</span> {status}
            </Badge>
          )}
        </div>

        <div aria-disabled={busy} className={`mt-3 flex flex-wrap gap-x-6 gap-y-2 ${busy ? 'pointer-events-none opacity-60' : ''}`}>
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-charcoal">
            <ToggleSwitch checked={saved.listed} onChange={(n) => void toggle('listed', n)} label={`${name} listed`} />
            Listed
          </label>
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-charcoal">
            <ToggleSwitch checked={saved.in_stock} onChange={(n) => void toggle('in_stock', n)} label={`${name} in stock`} />
            In stock
          </label>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-3">
          <Input
            label="Price (₹)"
            inputMode="numeric"
            autoComplete="off"
            placeholder="Set a price"
            className="font-mono tabular-nums"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))}
            error={fieldErrors.price}
          />
          <Input
            label="Packed weight (kg)"
            inputMode="decimal"
            autoComplete="off"
            className="font-mono tabular-nums"
            value={weight}
            onChange={(e) => setWeight(e.target.value.replace(/[^\d.]/g, ''))}
            error={fieldErrors.weight}
          />
        </div>
        <div className="mt-3">
          <Input
            label="Description (one line)"
            autoComplete="off"
            maxLength={DESCRIPTION_MAX}
            value={description}
            onChange={(e) => setDescription(e.target.value.replace(/\s+/g, ' '))}
            hint={`${description.length}/${DESCRIPTION_MAX}`}
          />
        </div>

        {dirty ? (
          <div className="mt-3">
            <Button type="submit" size="sm" variant="secondary" loading={busy}>
              Save {name}
            </Button>
          </div>
        ) : null}

        <p
          role={message && !message.ok ? 'alert' : 'status'}
          aria-live="polite"
          className={`mt-2 text-sm font-semibold ${message ? (message.ok ? 'text-green-800' : 'text-red-700') : ''}`}
        >
          {message?.text}
        </p>
      </form>
    </li>
  );
}

export function ShopProductsCard({ products }: { products: ShopProduct[] }) {
  if (products.length === 0) {
    return <p className="text-sm text-muted">No products yet. Apply the shop migration to add them.</p>;
  }
  return (
    <div>
      {LINE_ORDER.map((line) => {
        const rows = products.filter((p) => (p.line ?? 'instant') === line);
        if (rows.length === 0) return null;
        return (
          <section key={line} aria-labelledby={`products-${line}`} className="mt-3 first:mt-0">
            <h3 id={`products-${line}`} className="text-xs font-semibold uppercase tracking-wide text-muted">
              {PRODUCT_LINES[line].title}
            </h3>
            <ul className="divide-y divide-line">
              {rows.map((p) => (
                <ProductRow key={p.id} product={p} />
              ))}
            </ul>
          </section>
        );
      })}
      <p className="mt-3 text-xs text-muted">Changing a price never changes orders already placed.</p>
    </div>
  );
}
