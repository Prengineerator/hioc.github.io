// Owner → Shop orders (docs/INSTANT-COFFEE-SHOP.md, docs/SHOP-V2-SPEC.md): the
// two product lines sold on /shop (Instant Coffee jars and Signature Home Blend
// packs, ground to order), paid by Razorpay, shipped with Shiprocket. Customers
// can pay part with Beanies on repeat orders, and every shop order is synced to
// the customer's one account, kept apart from café orders. Only the owner sees
// these orders here; they never reach the counter's board or the café Reports.
//
// Server component, like app/owner/online/page.tsx: it reads the orders for the
// chosen tab, the counts, the last 30 days (units and revenue for each line) and
// the Products card's rows, and shows a setup checklist while something the shop
// needs is missing. The actions are
// client parts (components/owner/shop/*) that call /api/owner/shop/*.
//
// Reachable while the shop flag is off (not in the nav then), so the owner can
// check the setup before switching the shop on for customers.

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { ShopOfferSettings } from '@/components/owner/shop/ShopOfferSettings';
import { ShopOrderCard } from '@/components/owner/shop/ShopOrderCard';
import { ShopProductsCard } from '@/components/owner/shop/ShopProductsCard';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { flags } from '@/lib/flags';
import { isGatewayConfigured } from '@/lib/payments/gateway';
import { PLACEHOLDER_PRICE_INR } from '@/lib/shop/catalog';
import { shopLineStats } from '@/lib/shop/ownerStats';
import { rupees } from '@/lib/shop/pricing';
import { isMissingShopSchema, loadShopProducts, loadShopSettings, SHOP_MIGRATION_HINT, toShopOrderRow } from '@/lib/shop/server';
import { isShiprocketConfigured } from '@/lib/shop/shiprocket';
import { OWNER_STATUS_LABEL, OWNER_TABS, ownerTab, shiprocketBillCheck, shopOrderRef } from '@/lib/shop/status';
import type { ShopLine, ShopOrderRow, ShopOrderStatus } from '@/lib/shop/types';

export const dynamic = 'force-dynamic';

const LIST_LIMIT = 200;

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-charcoal">{value}</p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function SetupItem({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span aria-hidden="true" className={ok ? 'text-green-700' : 'text-amber-700'}>
        {ok ? '✓' : '•'}
      </span>
      <span className={ok ? 'text-muted' : 'text-charcoal'}>{children}</span>
    </li>
  );
}

export default async function OwnerShopPage({ searchParams }: { searchParams: { tab?: string } }) {
  const tab = ownerTab(searchParams.tab);
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [productsResult, listResult, countsResult, recentResult, settings, billsResult] = await Promise.all([
    loadShopProducts(admin),
    admin
      .from('shop_orders')
      .select('*')
      .in('status', [...tab.statuses])
      .order(tab.key === 'to_ship' ? 'paid_at' : 'created_at', {
        ascending: tab.key === 'to_ship',
      })
      .limit(LIST_LIMIT),
    admin.from('shop_orders').select('status').in('status', ['paid', 'sent_to_shiprocket', 'shipped']),
    // lines + shipping_inr feed the per-line stats; before the v2 migration
    // shipping_inr is still there (v1), and lines carry no `line` (read as instant).
    admin.from('shop_orders').select('status, lines, total_inr, shipping_inr, refunded_inr').gte('paid_at', since),
    loadShopSettings(admin),
    // Shiprocket's bill vs what the customer paid, for orders still on their
    // way. Errors (e.g. before 2026-11-shop-shiprocket-total.sql) skip it.
    admin
      .from('shop_orders')
      .select('order_number, total_inr, shiprocket_order_id, shiprocket_total_inr')
      .in('status', ['sent_to_shiprocket', 'shipped'])
      .not('shiprocket_total_inr', 'is', null),
  ]);

  const missingSchema = (!productsResult.ok && productsResult.missingSchema) || isMissingShopSchema(listResult.error);
  const orders: ShopOrderRow[] = (listResult.data ?? []).map((r) => toShopOrderRow(r as Record<string, unknown>));

  const open = new Map<string, number>();
  for (const r of (countsResult.data ?? []) as { status: ShopOrderStatus }[]) {
    const key = OWNER_TABS.find((t) => (t.statuses as readonly string[]).includes(r.status))?.key;
    if (key) open.set(key, (open.get(key) ?? 0) + 1);
  }

  type Recent = {
    status: ShopOrderStatus;
    lines: ShopLine[] | null;
    total_inr: number;
    shipping_inr: number | null;
    refunded_inr: number | null;
  };
  const stats = shopLineStats(
    ((recentResult.data ?? []) as Recent[]).map((r) => ({
      ...r,
      lines: r.lines ?? [],
    })),
  );

  // The setup list notices a missing v2 migration the same tolerant way the
  // loaders do (they fall back to v1 columns): the settings row lacks the
  // shipping columns, or the catalogue has no Home Blend rows.
  const products = productsResult.ok ? productsResult.products : [];
  const homeBlend = products.filter((p) => p.line === 'home_blend');
  const v2Missing =
    !missingSchema && ((settings !== null && settings.shipping_fee_inr === undefined) || (productsResult.ok && homeBlend.length === 0));
  const blendReady = homeBlend.length > 0 && homeBlend.every((p) => p.listed && p.price_inr > PLACEHOLDER_PRICE_INR);

  type Bill = {
    order_number: number;
    total_inr: number | string;
    shiprocket_order_id: string | null;
    shiprocket_total_inr: number | string;
  };
  const wrongBills = ((billsResult.error ? [] : (billsResult.data ?? [])) as Bill[]).filter(
    (b) =>
      shiprocketBillCheck({
        order_number: Number(b.order_number),
        shiprocket_order_id: b.shiprocket_order_id,
        total_inr: Number(b.total_inr),
        shiprocket_total_inr: Number(b.shiprocket_total_inr),
      })?.state === 'differs',
  );

  const razorpay = isGatewayConfigured();
  const shiprocket = isShiprocketConfigured();
  const setupDone = !missingSchema && !v2Missing && razorpay && shiprocket && flags.shop && blendReady;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Shop orders</h1>
          <p className="text-sm text-muted">
            Instant Coffee and Home Blend bought on the website. Pack them, send them to Shiprocket, and the customer gets the tracking link
            by email.
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          {flags.shop ? (
            <Link href="/shop" className="font-semibold text-tan-dark underline">
              View the shop
            </Link>
          ) : null}
          <a href="/api/owner/shop/orders/export" className="font-semibold text-tan-dark underline">
            Download CSV
          </a>
        </div>
      </div>

      {!setupDone ? (
        <section className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
          <h2 className="font-bold text-charcoal">Setting up the shop</h2>
          <ul className="mt-2 space-y-1">
            <SetupItem ok={!missingSchema}>Database: {missingSchema ? SHOP_MIGRATION_HINT : 'shop tables are in place'}</SetupItem>
            <SetupItem ok={!v2Missing}>
              {v2Missing
                ? 'Apply supabase/2026-11-shop-v2.sql (Home Blend, grinds, saved addresses, Beanies)'
                : 'Shop v2 migration is applied'}
            </SetupItem>
            <SetupItem ok={blendReady}>
              Price and list the Home Blend packs (250 g, 500 g, 1 kg) in the Products card; they stay hidden until you do
            </SetupItem>
            <SetupItem ok={razorpay}>Razorpay keys (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) — customers pay online</SetupItem>
            <SetupItem ok={shiprocket}>
              Shiprocket API user (SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD, and SHIPROCKET_PICKUP_LOCATION if your pickup address isn&apos;t
              named “Primary”) — for the one-click send
            </SetupItem>
            <SetupItem ok={flags.shop}>
              Switch the shop on for customers: NEXT_PUBLIC_FLAG_SHOP=true in Vercel, then redeploy. This also adds the Shop link to the
              website and the shop wording on the policy pages.
            </SetupItem>
          </ul>
          <p className="mt-2 text-muted">Step by step: docs/INSTANT-COFFEE-SHOP.md.</p>
        </section>
      ) : null}

      {wrongBills.length > 0 ? (
        <section role="alert" className="mt-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-bold">
            Shiprocket&apos;s bill doesn&apos;t match what the customer paid:{' '}
            {wrongBills.map((b) => shopOrderRef(Number(b.order_number))).join(', ')}
          </p>
          <p className="mt-1">
            The wrong amount goes on Shiprocket&apos;s invoice, its emails to the customer and the parcel&apos;s declared value. See the
            order under{' '}
            <Link href="/owner/shop?tab=with_courier" className="font-semibold underline">
              With courier
            </Link>
            .
          </p>
        </section>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="To ship" value={String(open.get('to_ship') ?? 0)} sub="paid, not sent yet" />
            <StatCard
              label="Instant Coffee"
              value={`${stats.instant.units} sold`}
              sub={`${rupees(stats.instant.revenue_inr)} · last 30 days`}
            />
            <StatCard
              label="Home Blend"
              value={`${stats.home_blend.units} sold`}
              sub={`${rupees(stats.home_blend.revenue_inr)} · last 30 days`}
            />
            <StatCard
              label="Last 30 days"
              value={rupees(stats.total.revenue_inr)}
              sub={`${stats.total.orders} orders · ${stats.total.units} units, shipping not counted`}
            />
          </div>

          <nav aria-label="Order status" className="mt-6 flex flex-wrap gap-2">
            {OWNER_TABS.map((t) => {
              const active = t.key === tab.key;
              const n = open.get(t.key);
              return (
                <Link
                  key={t.key}
                  href={`/owner/shop?tab=${t.key}`}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded-full px-3 py-1.5 text-sm font-semibold transition-colors ${
                    active ? 'bg-tan-dark text-cream' : 'border border-line text-charcoal hover:bg-surface'
                  }`}
                >
                  {t.label}
                  {n ? <span className="ml-1 tabular-nums">({n})</span> : null}
                </Link>
              );
            })}
          </nav>

          {missingSchema ? null : orders.length === 0 ? (
            <p className="mt-6 rounded-md border border-line bg-surface p-6 text-center text-sm text-muted">
              {tab.key === 'to_ship' ? 'Nothing to ship right now.' : 'No orders here.'}
            </p>
          ) : (
            <ul className="mt-4 space-y-4">
              {orders.map((o) => (
                <ShopOrderCard key={o.id} order={o} shiprocketReady={shiprocket} />
              ))}
            </ul>
          )}
          {tab.key === 'unpaid' && orders.length > 0 ? (
            <p className="mt-3 text-xs text-muted">
              Checkouts where the payment never completed ({OWNER_STATUS_LABEL.payment_pending} or {OWNER_STATUS_LABEL.expired}). No money
              was taken and nothing needs doing.
            </p>
          ) : null}
          {orders.length === LIST_LIMIT ? (
            <p className="mt-3 text-xs text-muted">Showing the {LIST_LIMIT} most recent. The CSV has them all.</p>
          ) : null}
        </div>

        <aside className="space-y-6">
          <section className="rounded-md border border-line bg-cream p-4 shadow-sm">
            <h2 className="font-bold text-charcoal">Online offer</h2>
            {settings ? (
              <div className="mt-2">
                <ShopOfferSettings settings={settings} />
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">Apply the shop migration to set the offer.</p>
            )}
          </section>
          <section className="rounded-md border border-line bg-cream p-4 shadow-sm">
            <h2 className="font-bold text-charcoal">Products</h2>
            <p className="mt-1 text-xs text-muted">
              Set the price, list or unlist, and switch “In stock” off when you run out; it shows “Out of stock” on the shop.
            </p>
            {productsResult.ok ? (
              <div className="mt-2">
                <ShopProductsCard products={productsResult.products} />
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">Apply the shop migration to manage products.</p>
            )}
          </section>
          <section className="rounded-md border border-line bg-cream p-4 text-sm shadow-sm">
            <h2 className="font-bold text-charcoal">How shipping works</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-charcoal">
              <li>Pack the order (grind the Home Blend as the card says) and check the weight.</li>
              <li>Press Send to Shiprocket on the order.</li>
              <li>In the Shiprocket panel: pick the courier, print the label, schedule the pickup.</li>
              <li>Press Refresh — the customer is emailed the tracking link.</li>
            </ol>
            <p className="mt-2 text-xs text-muted">Shipping fee and the free-shipping amount are set under Online offer. Prepaid only.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
