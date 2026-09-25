'use client';

import { useParams } from 'next/navigation';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { FeedbackThread } from '@/components/owner/FeedbackThread';

export default function OwnerFeedbackThreadPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <Link href="/owner/feedback" className="text-sm font-bold text-tan hover:underline">
        ← Back to feedback
      </Link>
      {id ? <FeedbackThread requestId={id} /> : null}
    </div>
  );
}
