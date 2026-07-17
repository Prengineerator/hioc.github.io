import { redirect } from 'next/navigation';

// The confirmation page used to be a static, fetch-once server render — so it
// never reflected status changes after the order was placed. Phase-1 makes the
// live status page (app/order/[id]) the single customer-facing order surface
// (real-time progress, ETA, pickup code, bill). This route is kept only as a
// stable alias for old links/bookmarks and immediately forwards there.
export default function OrderConfirmationRedirect({
  params,
}: {
  params: { orderId: string };
}) {
  redirect(`/order/${params.orderId}`);
}
