// Owner → Shop orders (docs/INSTANT-COFFEE-SHOP.md): Instant Coffee jars sold
// on /shop, paid by Razorpay, to be shipped with Shiprocket. Only the owner
// sees these orders; they never reach the counter's board or the café Reports.
//
// Server component, like app/owner/online/page.tsx: it reads the orders for the
// chosen tab, the counts, the last 30 days and the flavours' stock, and shows a
// setup checklist while something the shop needs is missing. The actions are
// client parts (components/owner/shop/*) that call /api/owner/shop/*.
//
// Reachable while the shop flag is off (not in the nav then), so the owner can
// check the setup before switching the shop on for customers.

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { ShopOrderCard } from '@/components/owner/shop/ShopOrderCard';
import { ShopStockToggles } from '@/components/owner/shop/ShopStockToggles';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { flags } from '@/lib/flags';
import { isGatewayConfigured } from '@/lib/payments/gateway';
import { rupees } from '@/lib/shop/pricing';
import { isMissingShopSchema, loadShopProducts, SHOP_MIGRATION_HINT, toShopOrderRow } from '@/lib/shop/server';
import { isShiprocketConfigured } from '@/lib/shop/shiprocket';
import { OWNER_TABS, ownerTab, PAID_STATUSES } from '@/lib/shop/status';
import type { ShopOrderRow, ShopOrderStatus } from '@/lib/shop/types';

export const dynamic = 'force-dynamic';

const LIST_LIMIT = 200;

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold text-charcoal">{value}</p>
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

  const [productsResult, listResult, countsResult, recentResult] = await Promise.all([
    loadShopProducts(admin),
    admin
      .from('shop_orders')
      .select('*')
      .in('status', [...tab.statuses])
      .order(tab.key === 'to_ship' ? 'paid_at' : 'created_at', { ascending: tab.key === 'to_ship' })
      .limit(LIST_LIMIT),
    admin.from('shop_orders').select('status').in('status', ['paid', 'sent_to_shiprocket', 'shipped']),
    admin.from('shop_orders').select('status, jar_count, total_inr, refunded_inr').gte('paid_at', since),
  ]);

  const missingSchema = (!productsResult.ok && productsResult.missingSchema) || isMissingShopSchema(listResult.error);
  const orders: ShopOrderRow[] = (listResult.data ?? []).map((r) => toShopOrderRow(r as Record<string, unknown>));

  const open = new Map<string, number>();
  for (const r of (countsResult.data ?? []) as { status: ShopOrderStatus }[]) {
    const key = OWNER_TABS.find((t) => (t.statuses as readonly string[]).includes(r.status))?.key;
    if (key) open.set(key, (open.get(key) ?? 0) + 1);
  }

  type Recent = { status: ShopOrderStatus; jar_count: number; total_inr: number; refunded_inr: number | null };
  const recent = ((recentResult.data ?? []) as Recent[]).filter((r) => r.status !== 'payment_pending');
  const kept = recent.filter((r) => PAID_STATUSES.includes(r.status));
  const revenue = kept.reduce((n, r) => n + Number(r.total_inr), 0);
  const jars = kept.reduce((n, r) => n + Number(r.jar_count), 0);

  const razorpay = isGatewayConfigured();
  const shiprocket = isShiprocketConfigured();
  const setupDone = !missingSchema && razorpay && shiprocket && flags.shop;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Shop orders</h1>
          <p className="text-sm text-muted">
            Instant Coffee jars bought on the website. Pack them, send them to Shiprocket, and the customer gets the tracking
            link by email.
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
            <SetupItem ok={razorpay}>Razorpay keys (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) — customers pay online</SetupItem>
            <SetupItem ok={shiprocket}>
              Shiprocket API user (SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD, and SHIPROCKET_PICKUP_LOCATION if your pickup
              address isn&apos;t named “Primary”) — for the one-click send
            </SetupItem>
            <SetupItem ok={flags.shop}>
              Switch the shop on for customers: NEXT_PUBLIC_FLAG_SHOP=true in Vercel, then redeploy. This also adds the Shop
              link to the website and the shop wording on the policy pages.
            </SetupItem>
          </ul>
          <p className="mt-2 text-muted">Step by step: docs/INSTANT-COFFEE-SHOP.md.</p>
        </section>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0">
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="To ship" value={String(open.get('to_ship') ?? 0)} sub="paid, not sent yet" />
            <StatCard label="Last 30 days" value={rupees(revenue)} sub={`${kept.length} orders`} />
            <StatCard label="Jars sold" value={String(jars)} sub="last 30 days" />
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
                <ShopOrderCard key={`${o.id}:${o.updated_at}`} order={o} shiprocketReady={shiprocket} />
              ))}
            </ul>
          )}
          {tab.key === 'unpaid' && orders.length > 0 ? (
            <p className="mt-3 text-xs text-muted">
              Checkouts where the payment never completed. No money was taken and nothing needs doing.
            </p>
          ) : null}
          {orders.length === LIST_LIMIT ? (
            <p className="mt-3 text-xs text-muted">Showing the {LIST_LIMIT} most recent. The CSV has them all.</p>
          ) : null}
        </div>

        <aside className="space-y-6">
          <section className="rounded-md border border-line bg-cream p-4 shadow-sm">
            <h2 className="font-bold text-charcoal">Flavours in stock</h2>
            <p className="mt-1 text-xs text-muted">Switch a flavour off when you run out; it shows “Out of stock” on the shop.</p>
            {productsResult.ok ? (
              <div className="mt-2">
                <ShopStockToggles products={productsResult.products} />
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">Apply the shop migration to manage flavours.</p>
            )}
          </section>
          <section className="rounded-md border border-line bg-cream p-4 text-sm shadow-sm">
            <h2 className="font-bold text-charcoal">How shipping works</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-charcoal">
              <li>Pack the jars and check the weight.</li>
              <li>Press Send to Shiprocket on the order.</li>
              <li>In the Shiprocket panel: pick the courier, print the label, schedule the pickup.</li>
              <li>Press Refresh — the customer is emailed the tracking link.</li>
            </ol>
            <p className="mt-2 text-xs text-muted">₹49 shipping is charged below 3 jars; 3 or more ship free. Prepaid only.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
