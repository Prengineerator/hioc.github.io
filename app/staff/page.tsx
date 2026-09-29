import { OrdersWorkspace } from '@/components/staff/OrdersWorkspace';

// "Live orders" — one oldest-first grid of active orders (no status lanes);
// completed ones drop off. Every order placed today, finished or not, is under
// "Orders" (/staff/orders).
export default function StaffLiveOrdersPage() {
  return <OrdersWorkspace view="live" />;
}
