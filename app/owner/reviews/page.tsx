// Owner ratings & feedback surface (LOY-3/RET-4). Reads reviews + the
// v_review_summary rollup directly via the admin client (Server Component,
// same convention as app/owner/page.tsx), computes the average/distribution/
// low-rated highlights in JS, and delegates respond/hide interactivity to
// <ReviewModeration>.

import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { Card } from '@/components/owner/dashboard';
import { ReviewModeration } from '@/components/reviews/ReviewModeration';
import type { Review, ReviewSummaryRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_REVIEWS = 200;

async function loadReviews(): Promise<Review[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('reviews')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(MAX_REVIEWS);
  if (error) {
    console.error('owner reviews: load failed', error);
    return [];
  }
  return (data ?? []) as Review[];
}

async function loadSummary(): Promise<ReviewSummaryRow[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('v_review_summary')
    .select('*')
    .order('review_date', { ascending: false })
    .limit(90);
  if (error) {
    console.error('owner reviews: summary failed', error);
    return [];
  }
  return (data ?? []) as ReviewSummaryRow[];
}

export default async function OwnerReviewsPage() {
  const [reviews, summary] = await Promise.all([loadReviews(), loadSummary()]);

  const visible = reviews.filter((r) => !r.hidden);
  const avgRating = visible.length > 0 ? visible.reduce((sum, r) => sum + r.rating, 0) / visible.length : null;
  const distribution = [1, 2, 3, 4, 5].map((star) => ({
    star,
    count: visible.filter((r) => r.rating === star).length,
  }));
  const lowRated = visible.filter((r) => r.rating <= 2).slice(0, 10);
  const totalVolume = summary.reduce((sum, r) => sum + r.reviews, 0);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold text-charcoal">Reviews</h1>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Average rating</p>
          <p className="mt-1 text-2xl font-bold text-charcoal">{avgRating === null ? '—' : avgRating.toFixed(2)}</p>
        </div>
        <div className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Reviews (visible)</p>
          <p className="mt-1 text-2xl font-bold text-charcoal">{visible.length}</p>
        </div>
        <div className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Volume (last 90 days)</p>
          <p className="mt-1 text-2xl font-bold text-charcoal">{totalVolume}</p>
        </div>
      </div>

      <Card title="Rating distribution">
        <div className="flex flex-col gap-1">
          {distribution.reverse().map(({ star, count }) => {
            const pct = visible.length > 0 ? Math.round((count / visible.length) * 100) : 0;
            return (
              <div key={star} className="flex items-center gap-2 text-sm">
                <span className="w-10 shrink-0 text-charcoal">{star}★</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-[#f2efe9]">
                  <div className="h-full rounded-full bg-tan" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-10 shrink-0 text-right text-muted">{count}</span>
              </div>
            );
          })}
        </div>
      </Card>

      {lowRated.length > 0 ? (
        <Card title="Low-rated orders needing attention">
          <ul className="flex flex-col gap-2 text-sm">
            {lowRated.map((r) => (
              <li key={r.id} className="border-b border-[#f2efe9] pb-2">
                <span className="font-bold text-red-700">{r.rating}★</span>{' '}
                <span className="text-charcoal">{r.comment || '(no comment)'}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="All reviews">
        <ReviewModeration initialReviews={reviews} />
      </Card>
    </div>
  );
}
