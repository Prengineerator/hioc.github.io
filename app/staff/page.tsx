import { OrdersWorkspace } from '@/components/staff/OrdersWorkspace';

// "Live orders" — the running board (received → ready). Every order placed
// today, finished or not, is under "Orders" (/staff/orders).
export default function StaffLiveOrdersPage() {
  return <OrdersWorkspace view="live" />;
}
