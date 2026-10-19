import { SettleWorkspace } from '@/components/staff/SettleWorkspace';
import { getCounterActor } from '@/lib/api/auth';
import { flags } from '@/lib/flags';
import { hasPermission } from '@/lib/permissions';
import { getStaffSurface } from '@/lib/staff/surface';
import { canTakeOrders } from '@/lib/staff/surfaceRules';
import { getStoreSettings } from '@/lib/store/settings';

export const dynamic = 'force-dynamic';

// "Settle" — every unpaid bill from any day, each settled in place with the
// same payment step as New order (cash + change, UPI, card, split). Opening a
// bill lets a person with the owner's say-so lower it before it is settled. The
// /staff/** layout already guarantees a counter actor and the API routes
// re-check everything (the amend route enforces the permission, the order's
// state and the add flow's own rules), so what is resolved here only decides
// what to OFFER:
//   canEdit      the `settle_edit_order` permission (default manager; the owner
//                can open it to staff on Team → Permissions);
//   canAddItems  the running-tab "Add items" flow: the POS screen is on, this
//                screen may take orders (the POS, or the staff website with web
//                ordering switched on: CP-D20) AND the `pos_order_entry`
//                permission, the one the add itself is checked against.
// The role comes from getCounterActor(), as on the other staff pages: it already
// caps a device-unlocked owner at 'manager', and hasPermission takes the role it
// is given rather than re-deriving one a PIN operator does not have a session for.
export default async function StaffSettlePage() {
  const [actor, surface, settings] = await Promise.all([getCounterActor(), getStaffSurface(), getStoreSettings()]);
  const [mayEdit, mayPunch] = actor
    ? await Promise.all([
        hasPermission(actor.user, 'settle_edit_order', actor.role),
        hasPermission(actor.user, 'pos_order_entry', actor.role),
      ])
    : [false, false];
  const canAddItems = flags.staffPos && canTakeOrders(surface, settings.staff_web_ordering) && mayPunch;

  return <SettleWorkspace canEdit={mayEdit} canAddItems={canAddItems} />;
}
