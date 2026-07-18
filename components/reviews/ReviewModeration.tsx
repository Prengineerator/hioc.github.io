'use client';

// Owner review moderation (LOY-3/OWN-036): respond to a review and/or hide
// abusive content. Seeded with `initialReviews` (fetched server-side by
// app/owner/reviews/page.tsx via the admin client); all mutations go through
// PATCH /api/reviews/[id].

import { useState } from 'react';
import { StarRating } from '@/components/reviews/StarRating';
import type { Review } from '@/lib/types';

export function ReviewModeration({ initialReviews }: { initialReviews: Review[] }) {
  const [reviews, setReviews] = useState(initialReviews);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  async function patchReview(id: string, patch: Record<string, unknown>) {
    const res = await fetch(`/api/reviews/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = await res.json();
      setReviews((prev) => prev.map((r) => (r.id === id ? (data.review as Review) : r)));
    }
  }

  async function toggleHidden(r: Review) {
    await patchReview(r.id, { hidden: !r.hidden });
  }

  function startRespond(r: Review) {
    setRespondingId(r.id);
    setDraft(r.staff_response);
  }

  async function submitResponse(id: string) {
    setSaving(true);
    try {
      await patchReview(id, { staff_response: draft });
      setRespondingId(null);
    } finally {
      setSaving(false);
    }
  }

  if (reviews.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No reviews yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {reviews.map((r) => (
        <li key={r.id} className={'rounded-md border p-4 ' + (r.hidden ? 'border-red-200 bg-red-50' : 'border-[#e5e5e5] bg-cream')}>
          <div className="flex items-center justify-between">
            <StarRating value={r.rating} size="sm" />
            <span className="text-xs text-muted">{new Date(r.created_at).toLocaleDateString('en-IN')}</span>
          </div>
          {r.comment ? <p className="mt-2 text-sm text-charcoal">&ldquo;{r.comment}&rdquo;</p> : null}
          <p className="mt-1 text-xs text-muted">
            Order {r.order_id.slice(0, 8)}
            {r.menu_item_id ? ` · item review` : ' · overall order'}
            {r.hidden ? ' · hidden' : ''}
          </p>

          {r.staff_response && respondingId !== r.id ? (
            <div className="mt-3 rounded-md bg-[#f2efe9] p-3 text-xs text-charcoal">
              <span className="font-bold">Your reply: </span>
              {r.staff_response}
            </div>
          ) : null}

          {respondingId === r.id ? (
            <div className="mt-3">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, 1000))}
                rows={2}
                className="w-full rounded-md border border-[#e5e5e5] p-2 text-sm outline-none focus:border-tan"
                placeholder="Write a response…"
              />
              <div className="mt-2 flex gap-3">
                <button type="button" onClick={() => submitResponse(r.id)} disabled={saving} className="rounded-md bg-tan px-3 py-1.5 text-xs font-bold text-cream hover:bg-tan-dark disabled:opacity-50">
                  {saving ? 'Saving…' : 'Post reply'}
                </button>
                <button type="button" onClick={() => setRespondingId(null)} className="text-xs font-bold text-muted hover:text-charcoal">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex gap-4 text-xs">
              <button type="button" onClick={() => startRespond(r)} className="font-bold text-tan hover:underline">
                {r.staff_response ? 'Edit reply' : 'Reply'}
              </button>
              <button type="button" onClick={() => toggleHidden(r)} className="font-bold text-red-700 hover:underline">
                {r.hidden ? 'Unhide' : 'Hide'}
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
