// Owner → Shop orders → New order (docs/SHOP-OWNER-ORDERS-SPEC.md): the owner types in a shipped
// order for a customer who phoned or WhatsApped. Thin server shell; the form is a client
// component that loads the listed, in-stock products and calls the other /api/owner/shop/* routes. Under /owner, which the
// middleware and the owner layout already guard (the API routes check the owner again).

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { OwnerNewOrderForm } from '@/components/owner/shop/OwnerNewOrderForm';

export const dynamic = 'force-dynamic';

export default function OwnerNewShopOrderPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:py-8">
      <Link href="/owner/shop" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark underline">
        <span aria-hidden="true">←&nbsp;</span>Shop orders
      </Link>
      <h1 className="mt-1 text-2xl font-bold text-charcoal">New order</h1>
      <p className="mt-1 text-sm text-muted">For a customer who phoned or WhatsApped. It is shipped like any shop order.</p>
      <OwnerNewOrderForm />
    </div>
  );
}
