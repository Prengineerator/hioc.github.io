import Link from 'next/link';
import { flags } from '@/lib/flags';
import { PosOrderEntry, type AddToOrderTarget } from '@/components/staff/PosOrderEntry';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { isUuid } from '@/lib/api/constants';

// The states in which an order can still take more items (mirrors the amend
// route's OPEN_STATUSES — the route is the real gate; this just avoids offering
// a flow that would 409).
const OPEN_STATUSES = ['accepted', 'preparing', 'ready'];

/**
 * TAB-2: resolves `?add=<orderId>` into the target the entry screen needs.
 * Returns null for anything that can't take items — an unknown id, a settled or
 * terminal order — so the screen falls back to normal new-order mode rather
 * than presenting an add flow that's guaranteed to fail.
 */
async function resolveAddTarget(orderId: string | null): Promise<AddToOrderTarget | null> {
  if (!orderId || !isUuid(orderId)) return null;

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from('orders')
    .select('id, order_number, status, payment_status, tables(label)')
    .eq('id', orderId)
    .maybeSingle();

  if (!data) return null;
  const row = data as unknown as {
    id: string;
    order_number: number;
    status: string;
    payment_status: string;
    // PostgREST returns the embed as an object for a many-to-one, but the
    // inferred type is an array — accept either rather than guess.
    tables?: { label: string } | { label: string }[] | null;
  };
  if (!OPEN_STATUSES.includes(row.status) || row.payment_status === 'paid') return null;

  const table = Array.isArray(row.tables) ? row.tables[0] : row.tables;

  return { id: row.id, orderNumber: row.order_number, tableLabel: table?.label ?? null };
}

// Staff POS-lite order entry (POS-1). The /staff/** layout already gates this
// route behind getStaffOrOwner(), so no extra auth check is needed here — a
// signed-in staff/manager/owner is guaranteed. This page is dark-launched
// behind the staffPos flag (default ON): when off it renders a clear
// "not enabled" state rather than the entry screen.
export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: { table?: string | string[]; add?: string | string[] };
}) {
  if (!flags.staffPos) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Order entry is not enabled</h1>
        <p className="mt-3 text-muted">
          The counter order-entry screen is turned off for this environment.
        </p>
        <Link
          href="/staff"
          className="mt-6 inline-flex rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Back to Orders
        </Link>
      </div>
    );
  }

  // POS-3 deep-link: /staff/orders/new?table=<id> pre-selects that dine-in table
  // (PosOrderEntry validates it against the active tables and ignores an unknown
  // id). Only a single string value is meaningful.
  const initialTableId =
    typeof searchParams.table === 'string' ? searchParams.table : null;

  // TAB-2 deep-link: /staff/orders/new?add=<orderId> appends to a running order.
  const addToOrder = await resolveAddTarget(
    typeof searchParams.add === 'string' ? searchParams.add : null,
  );

  return <PosOrderEntry initialTableId={initialTableId} addToOrder={addToOrder} />;
}
