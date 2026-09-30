import { SurfaceLink } from '@/components/SurfaceLink';
import { getCounterActor } from '@/lib/api/auth';
import { flags } from '@/lib/flags';
import { hasPermission } from '@/lib/permissions';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { initialPhoneFromQuery } from '@/lib/pos/ritual';
import { getStaffSurface } from '@/lib/staff/surface';
import { canTakeOrders, ORDERING_OFF_MESSAGE } from '@/lib/staff/surfaceRules';
import { getStoreSettings } from '@/lib/store/settings';
import { RitualPassesScreen } from '@/components/staff/passes/RitualPassesScreen';

export const dynamic = 'force-dynamic';

// "Ritual passes": sell a HIOC Ritual at the counter, see what a customer holds,
// collect payment for a sale, and (for a manager) extend a pass or give a cup
// back. The /staff/** layout already guarantees a counter actor (a session, or an
// enrolled device's PIN operator); the API routes re-check everything, so what is
// resolved here only decides what to OFFER:
//   canSell    the `pass_sell` permission AND a screen that may take orders (the
//              POS, or the staff website with web ordering switched on: CP-D20);
//   canManage  the `pass_manage` permission (default manager).
// The role comes from getCounterActor(), as on the other staff pages: it already
// caps a device-unlocked owner at 'manager', and hasPermission takes the role it
// is given rather than re-deriving one a PIN operator does not have a session for.
// `?phone=` pre-fills the number (the "Sell a Ritual" link on New order).
export default async function StaffPassesPage({
  searchParams,
}: {
  searchParams: { phone?: string | string[] };
}) {
  if (!flags.coffeePass) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">{PASS_PROGRAM_NAME} is not switched on</h1>
        <p className="mt-3 text-muted">The prepaid Ritual plans are turned off for this environment.</p>
        <SurfaceLink
          href="/staff"
          className="mt-6 inline-flex min-h-[44px] items-center rounded-md bg-tan-dark px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-darker"
        >
          Back to Orders
        </SurfaceLink>
      </div>
    );
  }

  const [actor, surface, settings] = await Promise.all([getCounterActor(), getStaffSurface(), getStoreSettings()]);
  const mayTakeOrders = canTakeOrders(surface, settings.staff_web_ordering);
  const [maySell, mayManage] = actor
    ? await Promise.all([
        hasPermission(actor.user, 'pass_sell', actor.role),
        hasPermission(actor.user, 'pass_manage', actor.role),
      ])
    : [false, false];

  const sellBlockedMessage = !mayTakeOrders
    ? ORDERING_OFF_MESSAGE
    : !maySell
      ? `You don’t have permission to sell ${PASS_PROGRAM_NAME}.`
      : null;

  return (
    <RitualPassesScreen
      initialPhone={initialPhoneFromQuery(searchParams.phone)}
      canManage={mayManage}
      canSell={mayTakeOrders && maySell}
      sellBlockedMessage={sellBlockedMessage}
    />
  );
}
