import { OrdersWorkspace } from '@/components/staff/OrdersWorkspace';

// "Orders" — every order placed today (running, completed, cancelled) with
// whether it has been paid; unpaid ones are highlighted. The running board is
// "Live orders" (/staff).
export default function StaffTodayOrdersPage() {
  return <OrdersWorkspace view="today" />;
}
