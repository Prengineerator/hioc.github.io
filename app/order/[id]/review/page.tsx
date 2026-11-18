'use client';

// Post-pickup review page (LOY-3/CUS-069). No login required — like the
// order-status page, the opaque order id in the URL is the access control,
// so a guest can rate straight from the link in their confirmation/status
// page. Logged-in customers who submit here are attributed via their session.

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
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
  // A network/server failure is not "not found": show a retry state instead.
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) return;
    setLoadError(false);
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
      } else {
        setLoadError(true);
      }
      if (reviewsRes.ok) {
        const data = await reviewsRes.json();
        setReviews(data.reviews as Review[]);
      }
    } catch {
      setLoadError(true);
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

  if (loadError && !order && !notFound) {
    return (
      <div role="alert" className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">We couldn&apos;t load your order.</h1>
        <p className="mt-4 text-muted">Check your connection and try again.</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            load();
          }}
          className="mt-6 min-h-[44px] rounded-md bg-tan-dark px-6 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker"
        >
          Try again
        </button>
      </div>
    );
  }

  if (notFound || !order) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Order Not Found</h1>
        <p className="mt-4 text-muted">We couldn&apos;t find that order. The link may be incorrect.</p>
        <Link href="/menu" className="mt-6 inline-block rounded-md bg-tan-dark px-6 py-3 font-semibold text-cream hover:bg-tan-darker">
          Back to Menu
        </Link>
      </div>
    );
  }

  if (order.status !== 'completed') {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">
          Order #<span className="font-mono tabular-nums">{formatOrderNumber(order.order_number)}</span>
        </h1>
        <p className="mt-4 text-muted">
          You can rate this order once it&apos;s been picked up. Check back after collection.
        </p>
        <Link href={`/order/${order.id}`} className="mt-6 inline-block rounded-md border border-line px-6 py-3 font-semibold text-charcoal hover:bg-surface">
          Back to order status
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-bold text-charcoal">Rate your order</h1>
      <p className="mt-1 text-sm text-muted">
        Order #<span className="font-mono tabular-nums">{formatOrderNumber(order.order_number)}</span>. How was it?
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
          <div className="rounded-md border border-line bg-cream p-5 shadow-sm">
            <h2 className="mb-3 text-base font-semibold text-charcoal">Rate individual items</h2>
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

      <Link href={`/order/${order.id}`} className="mt-8 inline-flex min-h-[44px] items-center text-sm text-tan-dark hover:underline">
        Back to order status
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
  const commentId = useId();

  if (existing) {
    return (
      <div className={compact ? '' : 'rounded-md border border-line bg-cream p-5 shadow-sm'}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-charcoal">{title}</h3>
          <StarRating value={existing.rating} size="sm" />
        </div>
        {existing.comment ? <p className="mt-2 text-sm text-muted">&ldquo;{existing.comment}&rdquo;</p> : null}
        {existing.staff_response ? (
          <div className="mt-3 rounded-md bg-surface p-3 text-sm text-charcoal">
            <span className="font-semibold">HIOC replied: </span>
            {existing.staff_response}
          </div>
        ) : null}
        <p className="mt-2 text-sm text-muted">Thanks for your feedback!</p>
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
        setError(data.error ?? 'Could not submit your review. Please try again.');
        return;
      }
      onSubmitted();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={compact ? '' : 'rounded-md border border-line bg-cream p-5 shadow-sm'}>
      <h3 className="text-sm font-semibold text-charcoal">{title}</h3>
      <div className="mt-2">
        <StarRating value={rating} onChange={setRating} size={compact ? 'sm' : 'md'} label={`Rating for ${title}`} />
      </div>
      {!compact ? (
        <div className="mt-3">
          <label htmlFor={commentId} className="mb-1 block text-sm font-semibold text-charcoal">
            Tell us more (optional)
          </label>
          <textarea
            id={commentId}
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT_LENGTH))}
            rows={3}
            className="w-full rounded-md border border-muted/80 p-2 text-base outline-none focus:border-tan-dark focus-visible:ring-2 focus-visible:ring-tan-dark"
          />
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting || rating < 1}
        className="mt-3 min-h-[44px] rounded-md bg-tan-dark px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-tan-darker disabled:opacity-50"
      >
        {submitting ? 'Submitting...' : 'Submit rating'}
      </button>
    </div>
  );
}
