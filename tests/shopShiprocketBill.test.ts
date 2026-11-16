import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveShiprocketTotal } from '@/lib/shop/server';
import { resetShiprocketTokenCache } from '@/lib/shop/shiprocket';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import { shopOrder } from './helpers/shopFixture';

// Shiprocket's bill check (docs/INSTANT-COFFEE-SHOP.md): "Send to Shiprocket"
// and "Refresh from Shiprocket" read Shiprocket's own order total back, save
// it, and warn when it isn't what the customer paid. Handler-level, on an
// in-memory database with Shiprocket's API stubbed.

const state: { admin: ReturnType<typeof makeFakeAdmin>; tables: Record<string, Row[]> } = {
  admin: makeFakeAdmin({}, { startMs: 0 }),
  tables: {},
};

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => state.admin }));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve({ id: 'owner-1' }) }));
vi.mock('@/lib/shop/emails', () => ({ sendShopShippedEmail: () => Promise.resolve() }));

const { POST: refresh } = await import('@/app/api/owner/shop/orders/[id]/refresh/route');
const { POST: send } = await import('@/app/api/owner/shop/orders/[id]/shiprocket/route');

const ID = '7d0c3f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
const PKG = { weight_kg: 1, length_cm: 28, breadth_cm: 12, height_cm: 10 };

// An order like HIOC-S1004: 3 jars, ₹1197, offer −₹448, free shipping, paid
// ₹749. Numbered 1005, since S1004 itself is an accepted exception.
const OFFER_ORDER = {
  order_number: 1005,
  jar_count: 3,
  subtotal_inr: 1197,
  discount_inr: 448,
  offer_name: 'Introductory offer',
  shipping_inr: 0,
  total_inr: 749,
};

/** What Shiprocket's order-details call answers with; null = HTTP 500. */
let details: Record<string, unknown> | null = {};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function req(body: unknown = {}) {
  return new Request(`http://localhost/api/owner/shop/orders/${ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seed(patch: Record<string, unknown>) {
  state.tables = { shop_orders: [{ ...shopOrder({ ...OFFER_ORDER }), ...patch } as Row] };
  state.admin = makeFakeAdmin(state.tables, { startMs: Date.parse('2026-11-16T12:00:00Z') });
}

const row = () => state.tables.shop_orders[0];

beforeEach(() => {
  process.env.SHIPROCKET_EMAIL = 'api@hioc.test';
  process.env.SHIPROCKET_PASSWORD = 'secret';
  resetShiprocketTokenCache();
  details = {};
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.endsWith('/auth/login')) return Promise.resolve(json({ token: 't' }));
      if (url.endsWith('/orders/create/adhoc')) return Promise.resolve(json({ order_id: 1733716182, shipment_id: 99, status: 'NEW' }));
      if (url.includes('/orders/show/')) {
        return Promise.resolve(details === null ? json({ message: 'down' }, 500) : json({ data: { id: 1733716182, status: 'NEW', ...details } }));
      }
      return Promise.resolve(json({}));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Refresh from Shiprocket', () => {
  beforeEach(() => seed({ status: 'sent_to_shiprocket', shiprocket_order_id: '1733716182', shiprocket_status: 'NEW' }));

  it("saves Shiprocket's total and warns when it isn't what the customer paid", async () => {
    details = { total: '301.00' };
    const res = await refresh(req(), { params: { id: ID } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { shiprocket_total_inr: number }; warning?: string };
    expect(body.order.shiprocket_total_inr).toBe(301);
    expect(body.warning).toContain("Shiprocket's bill says ₹301, but the customer paid ₹749");
    expect(row().shiprocket_total_inr).toBe(301);
  });

  it('does not warn for HIOC-S1004 itself at ₹301 (the accepted exception), but saves the amount', async () => {
    seed({ order_number: 1004, status: 'sent_to_shiprocket', shiprocket_order_id: '1733716182', shiprocket_status: 'NEW' });
    details = { total: '301.00' };
    const body = (await (await refresh(req(), { params: { id: ID } })).json()) as { order: { shiprocket_total_inr: number }; warning?: string };
    expect(body.warning).toBeUndefined();
    expect(body.order.shiprocket_total_inr).toBe(301);
  });

  it('says nothing more when the bill matches', async () => {
    details = { total: '749.00' };
    const body = (await (await refresh(req(), { params: { id: ID } })).json()) as { order: { shiprocket_total_inr: number }; warning?: string };
    expect(body.warning).toBeUndefined();
    expect(body.order.shiprocket_total_inr).toBe(749);
  });

  it("says so when Shiprocket's answer carries no total, and still refreshes", async () => {
    details = { shipments: { id: 99, awb: 'AWB1', courier: 'Amazon Shipping' } };
    const res = await refresh(req(), { params: { id: ID } });
    const body = (await res.json()) as { order: { status: string; shiprocket_total_inr: number | null }; warning?: string };
    expect(res.status).toBe(200);
    expect(body.order.status).toBe('shipped');
    expect(body.order.shiprocket_total_inr).toBeNull();
    expect(body.warning).toMatch(/bill total couldn't be read/);
  });
});

describe('Send to Shiprocket', () => {
  beforeEach(() => seed({ status: 'paid' }));

  it('reads the bill back right after creating the order and warns on a mismatch', async () => {
    details = { total: 301 };
    const res = await send(req(PKG), { params: { id: ID } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { status: string; shiprocket_total_inr: number }; warning?: string };
    expect(body.order.status).toBe('sent_to_shiprocket');
    expect(body.order.shiprocket_total_inr).toBe(301);
    expect(body.warning).toMatch(/^Sent to Shiprocket — but check the amount\. Shiprocket's bill says ₹301/);
    expect(row().shiprocket_order_id).toBe('1733716182');
  });

  it('still stands when the read-back fails; Refresh checks later', async () => {
    details = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await send(req(PKG), { params: { id: ID } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { status: string; shiprocket_total_inr: number | null }; warning?: string };
    expect(body.order.status).toBe('sent_to_shiprocket');
    expect(body.order.shiprocket_total_inr).toBeNull();
    expect(body.warning).toBeUndefined();
  });
});

describe('saveShiprocketTotal', () => {
  it('leaves the order as it was, quietly, before the migration adds the column', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const admin = {
      from: () => ({
        update: () => ({
          eq: () =>
            Promise.resolve({ error: { code: 'PGRST204', message: "Could not find the 'shiprocket_total_inr' column of 'shop_orders' in the schema cache" } }),
        }),
      }),
    };
    const order = shopOrder({ shiprocket_order_id: '1' });
    expect(await saveShiprocketTotal(admin as unknown as Parameters<typeof saveShiprocketTotal>[0], order, 301)).toBe(order);
    expect(errorLog).not.toHaveBeenCalled();
  });
});
