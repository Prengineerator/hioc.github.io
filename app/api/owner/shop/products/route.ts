import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { loadShopProducts } from '@/lib/shop/server';

export const dynamic = 'force-dynamic';

// GET /api/owner/shop/products — owner only (401 otherwise). What the New order page
// can sell: the listed, in-stock products, in the shop's order. Read only, no-store.
// 200 { products: [{ id, name, display_name, line: 'instant'|'home_blend', pack_grams,
//   price_inr, in_stock, requires_grind, sort_order, net_qty }] }
export async function GET(request: Request) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!(await rateLimitOk(`owner-shop-products:${clientIp(request)}`, 60, 600))) {
    return errorResponse(429, 'Too many tries — please wait a few minutes.');
  }
  const result = await loadShopProducts(createAdminSupabaseClient());
  if (!result.ok) return errorResponse(503, 'Could not load the products just now — please try again.');
  const products = result.products
    .filter((p) => p.listed && p.in_stock)
    .map((p) => ({
      id: p.id,
      name: p.name,
      display_name: p.display_name,
      line: p.line,
      pack_grams: p.pack_grams,
      price_inr: p.price_inr,
      in_stock: p.in_stock,
      requires_grind: p.requires_grind,
      sort_order: p.sort_order,
      net_qty: p.net_qty,
    }));
  return NextResponse.json({ products }, { headers: { 'Cache-Control': 'no-store' } });
}
