'use client';

// Post-pickup review page (LOY-3/CUS-069). No login required — like the
// order-status page, the opaque order id in the URL is the access control,
// so a guest can rate straight from the link in their confirmation/status
// page. Logged-in customers who submit here are attributed via their session.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { StarRating } from '@/components/reviews/StarRating';
import { Spinner } from '@/components/ui/Spinner';
import type { Order, OrderItem, Review } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

const MAX_COMMENT_LENGTH = 1000;

export default function OrderReviewPage() {
  const params = useParams<{ id: string }>();
  const orderId = params?.id ?? null;

  const [order, setOrder] = useState<OrderWithItems | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) return;
    try {
      const [orderRes, reviewsRes] = await Promise.all([
        fetch(`/api/orders/${orderId}`, { cache: 'no-store' }),
        fetch(`/api/reviews?order_id=${orderId}`, { cache: 'no-store' }),
      ]);
      if (orderRes.status === 404) {
        setNotFound(true);
        return;
      }
      if (orderRes.ok) {
        const data = await orderRes.json();
        setOrder(data.order as OrderWithItems);
      }
      if (reviewsRes.ok) {
        const data = await reviewsRes.json();
        setReviews(data.reviews as Review[]);
      }
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  const uniqueItems = useMemo(() => {
    if (!order) return [];
    const seen = new Map<string, string>();
    for (const item of order.items) {
      if (item.menu_item_id && !seen.has(item.menu_item_id)) {
        seen.set(item.menu_item_id, item.name_snapshot);
      }
    }
    return [...seen.entries()].map(([menu_item_id, name]) => ({ menu_item_id, name }));
  }, [order]);

  if (loading) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <Spinner label="Loading your order…" />
      </div>
    );
  }

  if (notFound || !order) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Order Not Found</h1>
        <p className="mt-4 text-muted">We couldn&apos;t find that order. The link may be incorrect.</p>
        <Link href="/menu" className="mt-6 inline-block rounded-md bg-tan px-6 py-3 font-bold text-cream hover:bg-tan-dark">
          Back to Menu
        </Link>
      </div>
    );
  }

  if (order.status !== 'completed') {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Order #{formatOrderNumber(order.order_number)}</h1>
        <p className="mt-4 text-muted">
          You can rate this order once it&apos;s been picked up. Check back after collection.
        </p>
        <Link href={`/order/${order.id}`} className="mt-6 inline-block rounded-md border border-[#e5e5e5] px-6 py-3 font-bold text-charcoal hover:bg-[#f2efe9]">
          Back to order status
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-bold text-charcoal">Rate your order</h1>
      <p className="mt-1 text-sm text-muted">
        Order #{formatOrderNumber(order.order_number)} — how was it?
      </p>

      <div className="mt-8 flex flex-col gap-6">
        <ReviewBlock
          orderId={order.id}
          menuItemId={null}
          title="Overall experience"
          existing={reviews.find((r) => r.menu_item_id === null) ?? null}
          onSubmitted={load}
        />

        {uniqueItems.length > 0 ? (
          <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-charcoal">Rate individual items</h2>
            <div className="flex flex-col gap-5">
              {uniqueItems.map((item) => (
                <ReviewBlock
                  key={item.menu_item_id}
                  orderId={order.id}
                  menuItemId={item.menu_item_id}
                  title={item.name}
                  existing={reviews.find((r) => r.menu_item_id === item.menu_item_id) ?? null}
                  onSubmitted={load}
                  compact
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <Link href={`/order/${order.id}`} className="mt-8 inline-block text-sm text-tan hover:underline">
        ← Back to order status
      </Link>
    </div>
  );
}

function ReviewBlock({
  orderId,
  menuItemId,
  title,
  existing,
  onSubmitted,
  compact,
}: {
  orderId: string;
  menuItemId: string | null;
  title: string;
  existing: Review | null;
  onSubmitted: () => void;
  compact?: boolean;
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (existing) {
    return (
      <div className={compact ? '' : 'rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm'}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-charcoal">{title}</h3>
          <StarRating value={existing.rating} size="sm" />
        </div>
        {existing.comment ? <p className="mt-2 text-sm text-muted">&ldquo;{existing.comment}&rdquo;</p> : null}
        {existing.staff_response ? (
          <div className="mt-3 rounded-md bg-[#f2efe9] p-3 text-xs text-charcoal">
            <span className="font-bold">HIOC replied: </span>
            {existing.staff_response}
          </div>
        ) : null}
        <p className="mt-2 text-xs text-muted">Thanks for your feedback!</p>
      </div>
    );
  }

  async function handleSubmit() {
    if (rating < 1) {
      setError('Please select a star rating');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId, menu_item_id: menuItemId, rating, comment }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Could not submit your review — please try again.');
        return;
      }
      onSubmitted();
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={compact ? '' : 'rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm'}>
      <h3 className="text-sm font-bold text-charcoal">{title}</h3>
      <div className="mt-2">
        <StarRating value={rating} onChange={setRating} size={compact ? 'sm' : 'md'} />
      </div>
      {!compact ? (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT_LENGTH))}
          placeholder="Tell us more (optional)"
          rows={3}
          className="mt-3 w-full rounded-md border border-[#e5e5e5] p-2 text-sm outline-none focus:border-tan"
        />
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting || rating < 1}
        className="mt-3 rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : 'Submit rating'}
      </button>
    </div>
  );
}
