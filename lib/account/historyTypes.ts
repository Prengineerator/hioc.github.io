// Client-safe shapes for GET /api/account/history (docs/SHOP-V2-SPEC.md E4).
// No server-only imports: the account pages and the menu's Order-again strip
// import these.
//
// NAMING: café orders already carry `Order.channel` (web / qr / dine_in …),
// which says HOW a café order was placed. The café/shop split used here is the
// history ITEM's own `channel`, one level up. The two are never mixed.

import type { OrderResponse } from '@/lib/api/orders';
import type { LegacyCustomerOrderResponse } from '@/lib/api/customerOrders';
import type { ShopHistoryOrder } from '@/lib/shop/types';

export type HistoryChannel = 'cafe' | 'shop';
export type HistoryChannelFilter = 'all' | 'cafe' | 'shop';

/** One row of the merged history, in page order. */
export type AccountHistoryItem =
  | { channel: 'cafe'; id: string; created_at: string; order: OrderResponse }
  | { channel: 'shop'; id: string; created_at: string; order: ShopHistoryOrder };

export interface AccountHistoryResponse {
  /** The café orders on this page, in page order (kept for existing callers). */
  orders: OrderResponse[];
  /** Café and shop orders on this page, newest first. */
  items: AccountHistoryItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  phoneVerified: boolean;
  status: 'active' | 'past' | null;
  channel: HistoryChannelFilter;
  petpooja_orders: LegacyCustomerOrderResponse[];
}
