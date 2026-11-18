import 'server-only';

// Saved-address CRUD for the account API (docs/SHOP-V2-SPEC.md E3).
//
// Every helper takes the USER-SESSION Supabase client (createServerSupabaseClient),
// so row-level security already limits it to the caller's rows, and ALSO adds
// `.eq('user_id', userId)` itself: the spec's "server-side check", so a policy
// slip could never expose another customer's address.
//
// Results are discriminated unions, never thrown, so the routes only map a
// kind to an HTTP status:
//   limit      → 409 (trigger 'customer_addresses_limit', SQLSTATE P0001)
//   not_setup  → 503 (table missing, 42P01: the migration is not applied yet)
//   not_found  → 404
//   error      → 500

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CustomerAddress, SavedAddressFields } from '@/lib/shop/types';
import type { ShopLocation } from '@/lib/shop/location';
import { sameDeliveryAddress } from '@/lib/shop/address';
import { ADDRESS_LIMIT_MESSAGE, canAddAddress, nextDefaultAfterDelete, sortAddresses } from './addressRules';

export const NOT_SET_UP_MESSAGE = "Saved addresses aren't available yet.";

type Fail = { ok: false; kind: 'limit' | 'not_setup' | 'not_found' | 'error'; message: string };
export type Result<T> = ({ ok: true } & T) | Fail;

type DbError = { code?: string; message?: string } | null;

const TABLE = 'customer_addresses';

const fail = (kind: Fail['kind'], message: string): Fail => ({ ok: false, kind, message });

/** The one place a Postgres error becomes one of our kinds. */
function mapError(error: NonNullable<DbError>): Fail {
  // 42P01 from Postgres; PostgREST reports a table (PGRST205) or function (PGRST202) it can't find.
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST202') return fail('not_setup', NOT_SET_UP_MESSAGE);
  if (error.code === 'P0001' && /customer_addresses_limit/.test(error.message ?? '')) return fail('limit', ADDRESS_LIMIT_MESSAGE);
  if (error.code === 'P0002') return fail('not_found', 'Address not found');
  console.error('customer_addresses query failed', error);
  return fail('error', 'Could not reach your saved addresses. Try again.');
}

/** What the caller supplies when saving: validated fields, an optional pin, an optional default flag. */
export interface NewAddress extends SavedAddressFields {
  label: string;
  /** Did the caller actually send a label? A duplicate keeps its existing label unless this is true. */
  labelSupplied?: boolean;
  location?: ShopLocation | null;
  is_default?: boolean;
}

const locationColumns = (loc: ShopLocation | null | undefined) => ({
  location_lat: loc?.lat ?? null,
  location_lng: loc?.lng ?? null,
  location_source: loc?.source ?? null,
});

/** numeric columns may arrive as text; hand the UI numbers. */
function shape(row: CustomerAddress): CustomerAddress {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return { ...row, location_lat: num(row.location_lat), location_lng: num(row.location_lng) };
}

export async function listAddresses(db: SupabaseClient, userId: string): Promise<Result<{ addresses: CustomerAddress[] }>> {
  const { data, error } = await db.from(TABLE).select('*').eq('user_id', userId);
  if (error) return mapError(error);
  return { ok: true, addresses: sortAddresses(((data ?? []) as CustomerAddress[]).map(shape)) };
}

async function getOwned(db: SupabaseClient, userId: string, id: string): Promise<Result<{ address: CustomerAddress }>> {
  const { data, error } = await db.from(TABLE).select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) return mapError(error);
  if (!data) return fail('not_found', 'Address not found');
  return { ok: true, address: shape(data as CustomerAddress) };
}

/**
 * Makes one address the default through the RPC (it unsets the others first,
 * so the partial unique index is never violated). Returns the fresh row.
 */
export async function makeDefault(db: SupabaseClient, userId: string, id: string): Promise<Result<{ address: CustomerAddress }>> {
  // Ownership first: a clean 404 for anyone else's id.
  const owned = await getOwned(db, userId, id);
  if (!owned.ok) return owned;
  const { error } = await db.rpc('make_customer_address_default', { p_address_id: id });
  if (error) return mapError(error);
  return getOwned(db, userId, id);
}

/**
 * Saves an address. Order of business: the 10-address check (TS first, the
 * trigger as backstop), a de-dupe against what is already saved, the insert,
 * then the default. The first address is always made default.
 */
export async function createAddress(
  db: SupabaseClient,
  userId: string,
  input: NewAddress,
): Promise<Result<{ address: CustomerAddress; created: boolean }>> {
  const listed = await listAddresses(db, userId);
  if (!listed.ok) return listed;
  const existing = listed.addresses;

  const dup = existing.find((a) => sameDeliveryAddress(a, input));
  if (dup) {
    // Same place: keep one row. Refresh its label only when the caller sent one
    // (a missing label normalises to 'Home' and must not rename 'Work'), and
    // make it default when asked.
    const relabel = input.labelSupplied === true && input.label !== dup.label;
    if (relabel) {
      const { error } = await db.from(TABLE).update({ label: input.label }).eq('id', dup.id).eq('user_id', userId);
      if (error) return mapError(error);
    }
    const kept = relabel ? { ...dup, label: input.label } : dup;
    if (input.is_default && !dup.is_default) {
      const made = await makeDefault(db, userId, dup.id);
      if (!made.ok) return made;
      return { ok: true, address: made.address, created: false };
    }
    return { ok: true, address: kept, created: false };
  }

  if (!canAddAddress(existing.length)) return fail('limit', ADDRESS_LIMIT_MESSAGE);

  const first = existing.length === 0;
  const { is_default, location, label, labelSupplied: _labelSupplied, ...fields } = input;
  const row = { ...fields, label, ...locationColumns(location), user_id: userId, is_default: first };

  const { data, error } = await db.from(TABLE).insert(row).select('*').single();
  if (error) {
    // Two first-address requests racing: the default index rejected ours. Save as non-default and promote via the RPC.
    if (error.code === '23505' && first) {
      const retry = await db.from(TABLE).insert({ ...row, is_default: false }).select('*').single();
      if (retry.error) return mapError(retry.error);
      return finishDefault(db, userId, shape(retry.data as CustomerAddress), is_default === true);
    }
    return mapError(error);
  }
  return finishDefault(db, userId, shape(data as CustomerAddress), !first && is_default === true);
}

async function finishDefault(
  db: SupabaseClient,
  userId: string,
  address: CustomerAddress,
  wantDefault: boolean,
): Promise<Result<{ address: CustomerAddress; created: boolean }>> {
  if (!wantDefault || address.is_default) return { ok: true, address, created: true };
  const made = await makeDefault(db, userId, address.id);
  if (!made.ok) return made;
  return { ok: true, address: made.address, created: true };
}

/** Updates the given columns of one of the caller's addresses. `patch` is already validated. */
export async function updateAddress(
  db: SupabaseClient,
  userId: string,
  id: string,
  patch: Partial<NewAddress>,
): Promise<Result<{ address: CustomerAddress }>> {
  const owned = await getOwned(db, userId, id);
  if (!owned.ok) return owned;
  const { location, is_default, ...fields } = patch;
  const update: Record<string, unknown> = { ...fields };
  if (location !== undefined) Object.assign(update, locationColumns(location));
  if (Object.keys(update).length > 0) {
    const { error } = await db.from(TABLE).update(update).eq('id', id).eq('user_id', userId);
    if (error) return mapError(error);
  }
  if (is_default === true && !owned.address.is_default) return makeDefault(db, userId, id);
  return getOwned(db, userId, id);
}

/**
 * Deletes one of the caller's addresses. Deleting the default promotes the
 * next one (default → recent → newest). Past orders keep their frozen address:
 * shop_orders.customer_address_id is set null by the foreign key.
 */
export async function deleteAddress(
  db: SupabaseClient,
  userId: string,
  id: string,
): Promise<Result<{ new_default_id: string | null }>> {
  const listed = await listAddresses(db, userId);
  if (!listed.ok) return listed;
  if (!listed.addresses.some((a) => a.id === id)) return fail('not_found', 'Address not found');
  const next = nextDefaultAfterDelete(listed.addresses, id);

  const { error } = await db.from(TABLE).delete().eq('id', id).eq('user_id', userId);
  if (error) return mapError(error);
  if (next) {
    const made = await makeDefault(db, userId, next);
    if (!made.ok) return made;
  }
  return { ok: true, new_default_id: next };
}

/** The HTTP status for a failed result (shared by the three routes). */
export function statusFor(kind: Fail['kind']): number {
  return kind === 'limit' ? 409 : kind === 'not_setup' ? 503 : kind === 'not_found' ? 404 : 500;
}

/** The frozen address of one of the caller's shop orders, as a saved-address draft. Null when it is not theirs. */
export async function addressFromShopOrder(
  admin: SupabaseClient,
  userId: string,
  orderId: string,
): Promise<NewAddress | null> {
  const { data, error } = await admin
    .from('shop_orders')
    .select(
      'customer_name, phone, address_line1, address_line2, landmark, city, state, pincode, location_lat, location_lng, location_source',
    )
    .eq('id', orderId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  const lat = r.location_lat === null || r.location_lat === undefined ? NaN : Number(r.location_lat);
  const lng = r.location_lng === null || r.location_lng === undefined ? NaN : Number(r.location_lng);
  const location: ShopLocation | null =
    Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng, accuracy_m: null, source: r.location_source === 'gps' ? 'gps' : 'map' }
      : null;
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  return {
    label: 'Home',
    customer_name: s('customer_name'),
    phone: s('phone'),
    address_line1: s('address_line1'),
    address_line2: s('address_line2'),
    landmark: s('landmark'),
    city: s('city'),
    state: s('state'),
    pincode: s('pincode'),
    location,
  };
}
