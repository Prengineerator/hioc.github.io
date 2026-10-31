'use client';

// "May this screen take orders?" for New order and Tables, answered from the
// staff shell instead of the database.
//
// Both pages used to look the device and the store settings up again on every
// visit — two database reads standing between a tap on New order and the
// screen, on top of the sign-in check. app/staff/layout.tsx already resolved
// exactly that (the surface and staff_web_ordering) when the shell loaded, and
// hands it to StaffShell, so the pages read it from there and render with no
// server work of their own.
//
// This only decides what to SHOW. POST /api/orders, the amend route and the
// pass sale re-check the surface and the setting on every write, so a shell
// loaded before the owner flipped the setting can't take an order the server
// would refuse.

import { useStaffShell } from '@/components/staff/StaffShell';
import { OrderingOffNotice } from '@/components/staff/OrderingOffNotice';

export function TakeOrdersGate({ children }: { children: React.ReactNode }) {
  const { canTakeOrders } = useStaffShell();
  return canTakeOrders ? <>{children}</> : <OrderingOffNotice />;
}
