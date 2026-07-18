// Server-side realtime broadcast (F2). Customers can't read the `orders` table
// via the anon key (RLS blocks it), so postgres_changes won't reach the
// customer live-status page. Instead the transition Route Handlers broadcast a
// lightweight "your order changed" ping on a per-order channel; the customer
// hook (useOrderRealtime) listens and refetches through the server route.
//
// supabase-js sends broadcasts over HTTP when the socket isn't joined, which is
// exactly right for short-lived serverless handlers. Best-effort: never throws,
// so a realtime hiccup can't fail the underlying status change.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import type { OrderStatus } from '@/lib/types';

export function orderChannelName(orderId: string): string {
  return `order-${orderId}`;
}

export async function broadcastOrderEvent(
  orderId: string,
  status: OrderStatus,
): Promise<void> {
  try {
    const admin = createAdminSupabaseClient();
    const channel = admin.channel(orderChannelName(orderId), {
      config: { broadcast: { ack: false } },
    });
    await channel.send({
      type: 'broadcast',
      event: 'status',
      payload: { orderId, status, at: new Date().toISOString() },
    });
    await admin.removeChannel(channel);
  } catch (err) {
    console.error('broadcastOrderEvent failed (non-fatal)', err);
  }
}
