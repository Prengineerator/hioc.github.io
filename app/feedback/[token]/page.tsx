'use client';

// Public, token-gated web feedback page — the URL button on order_feedback_1
// points here. No login; the opaque token in the path IS the access control,
// same contract as /order/[id]. Mobile-first (this is opened from a WhatsApp
// message on a phone) and fast: one fetch on mount, one submit.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { StarRating } from '@/components/reviews/StarRating';
import { CAFE_NAME } from '@/lib/constants';

interface OrderItemLite {
  id: string;
  menu_item_id: string | null;
  name_snapshot: string;
  quantity: number;
}

interface LoadedState {
  order: { order_number: string; items: OrderItemLite[] };
  rating: number | null;
  comment: string;
  itemReviews: { menu_item_id: string | null; thumb: 'up' | 'down' }[];
}

type PageState =
  | { status: 'loading' }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; data: LoadedState };

const MAX_COMMENT = 1000;

export default function FeedbackPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, 'up' | 'down'>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`/api/feedback/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok || !data.valid) {
          setState({ status: 'invalid', reason: data.reason ?? 'not_found' });
          return;
        }
        setState({ status: 'ready', data });
        setRating(data.rating ?? 0);
        setComment(data.comment ?? '');
        const t: Record<string, 'up' | 'down'> = {};
        for (const ir of data.itemReviews ?? []) {
          if (ir.menu_item_id) t[ir.menu_item_id] = ir.thumb;
        }
        setThumbs(t);
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'invalid', reason: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  function toggleThumb(menuItemId: string, value: 'up' | 'down') {
    setThumbs((t) => {
      const next = { ...t };
      if (next[menuItemId] === value) {
        delete next[menuItemId];
      } else {
        next[menuItemId] = value;
      }
      return next;
    });
  }

  async function submit() {
    if (rating < 1) {
      setError('Please choose a star rating.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/feedback/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment, itemThumbs: thumbs }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Something went wrong — please try again.');
        return;
      }
      setSaved(true);
    } catch {
      setError('Something went wrong — please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <Spinner label="Loading…" />
      </div>
    );
  }

  if (state.status === 'invalid') {
    const message =
      state.reason === 'expired'
        ? "This feedback link has expired. If you'd still like to tell us something, just message us on WhatsApp."
        : "We couldn't find this feedback link. It may have been replaced by a newer one, or the link is incomplete.";
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-charcoal">{CAFE_NAME}</h1>
        <p className="text-sm text-muted">{message}</p>
      </div>
    );
  }

  const { order } = state.data;

  if (saved) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-charcoal">Thank you!</h1>
        <p className="text-sm text-muted">
          Your feedback for order {order.order_number} has been recorded. We read every one — thank you for taking
          the time.
        </p>
        <Button variant="secondary" onClick={() => setSaved(false)}>
          Edit my feedback
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
      <div>
        <h1 className="text-xl font-bold text-charcoal">How was your order?</h1>
        <p className="mt-1 text-sm text-muted">Order {order.order_number} · {CAFE_NAME}</p>
      </div>

      <div className="flex flex-col items-center gap-2 rounded-md border border-line bg-cream py-6 shadow-sm">
        <StarRating value={rating} onChange={setRating} size="lg" label="Rate your order" />
        <p className="text-xs text-muted">{rating > 0 ? `${rating} out of 5` : 'Tap to rate'}</p>
      </div>

      {order.items.length > 0 ? (
        <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">How were the items?</h2>
          <ul className="flex flex-col gap-3">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3">
                <span className="text-sm text-charcoal">
                  {item.name_snapshot}
                  {item.quantity > 1 ? ` ×${item.quantity}` : ''}
                </span>
                {item.menu_item_id ? (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-pressed={thumbs[item.menu_item_id] === 'up'}
                      onClick={() => toggleThumb(item.menu_item_id as string, 'up')}
                      className={
                        'rounded-md px-2 py-1.5 text-lg ' +
                        (thumbs[item.menu_item_id] === 'up' ? 'bg-tan text-cream' : 'bg-surface text-muted')
                      }
                    >
                      👍
                    </button>
                    <button
                      type="button"
                      aria-pressed={thumbs[item.menu_item_id] === 'down'}
                      onClick={() => toggleThumb(item.menu_item_id as string, 'down')}
                      className={
                        'rounded-md px-2 py-1.5 text-lg ' +
                        (thumbs[item.menu_item_id] === 'down' ? 'bg-charcoal text-cream' : 'bg-surface text-muted')
                      }
                    >
                      👎
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Textarea
        label="Anything you'd like to tell us? (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT))}
        rows={4}
        placeholder="Tell us more…"
      />

      {error ? <p className="text-sm font-semibold text-red-700">{error}</p> : null}

      <Button onClick={submit} loading={saving} fullWidth size="lg">
        Submit feedback
      </Button>
    </div>
  );
}
