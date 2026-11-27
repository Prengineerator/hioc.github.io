// What the owner's New order page offers once a phone number is typed
// (GET /api/owner/shop/customer): the account that holds that phone VERIFIED,
// its saved addresses, and the address on that phone's latest paid shop order.
// Read on the server for the one number the owner typed; never sent anywhere else.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findVerifiedCustomerByPhone } from '@/lib/loyalty/customerLink';
import { isMissingColumnError, safeDbError } from '@/lib/api/postgrest';
import { sameDeliveryAddress } from './address';
import { PAID_STATUSES } from './status';

export interface OwnerCustomerAddress {
  label: string;
  customer_name: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  landmark: string;
  city: string;
  state: string;
  pincode: string;
  source: 'saved' | 'last_order';
}

export interface OwnerCustomerLookup {
  name: string;
  email: string;
  account_linked: boolean;
  /** The linked account's id, for linking the order. Not sent to the browser. */
  user_id: string | null;
  addresses: OwnerCustomerAddress[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** `phoneE164` is +91XXXXXXXXXX (already validated by the caller). Never throws: a failed read is just "nothing to offer". */
export async function lookupOwnerCustomer(admin: SupabaseClient, phoneE164: string): Promise<OwnerCustomerLookup> {
  const out: OwnerCustomerLookup = { name: '', email: '', account_linked: false, user_id: null, addresses: [] };

  try {
    const linked = await findVerifiedCustomerByPhone(admin, phoneE164);
    if (linked) {
      out.account_linked = true;
      out.user_id = linked.userId;
      out.name = linked.name;
      const { data, error } = await admin
        .from('customer_addresses')
        .select('*')
        .eq('user_id', linked.userId)
        .order('last_used_at', { ascending: false, nullsFirst: false })
        .limit(10);
      if (error) console.error('owner customer lookup: saved addresses failed', safeDbError(error));
      for (const a of (data ?? []) as Record<string, unknown>[]) {
        out.addresses.push({
          label: str(a.label) || 'Saved',
          customer_name: str(a.customer_name),
          phone: str(a.phone),
          address_line1: str(a.address_line1),
          address_line2: str(a.address_line2),
          landmark: str(a.landmark),
          city: str(a.city),
          state: str(a.state),
          pincode: str(a.pincode),
          source: 'saved',
        });
      }
    }
  } catch (e) {
    console.error('owner customer lookup: account lookup failed', safeDbError(e));
  }

  try {
    const { data, error } = await admin
      .from('shop_orders')
      .select('*')
      .eq('phone', phoneE164)
      .in('status', [...PAID_STATUSES])
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      if (!isMissingColumnError(error)) console.error('owner customer lookup: last order failed', safeDbError(error));
    } else {
      const last = ((data ?? []) as Record<string, unknown>[])[0];
      if (last) {
        if (!out.name) out.name = str(last.customer_name);
        out.email = str(last.email);
        const addr: OwnerCustomerAddress = {
          label: 'Last order',
          customer_name: str(last.customer_name),
          phone: str(last.phone),
          address_line1: str(last.address_line1),
          address_line2: str(last.address_line2),
          landmark: str(last.landmark),
          city: str(last.city),
          state: str(last.state),
          pincode: str(last.pincode),
          source: 'last_order',
        };
        if (!out.addresses.some((a) => sameDeliveryAddress(a, addr))) out.addresses.push(addr);
      }
    }
  } catch (e) {
    console.error('owner customer lookup: last order threw', safeDbError(e));
  }
  return out;
}
