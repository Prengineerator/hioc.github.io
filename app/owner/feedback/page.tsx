// Owner feedback inbox. The layout + middleware gate /owner/** to role
// 'owner'; the APIs this page's client component calls re-check getOwnerUser()
// on every request.

import { FeedbackInbox } from '@/components/owner/FeedbackInbox';

export const dynamic = 'force-dynamic';

export default function OwnerFeedbackPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Feedback</h1>
        <p className="text-sm text-muted">
          Post-order WhatsApp feedback and replies — read what customers said, and work each thread to resolution.
        </p>
      </div>
      <FeedbackInbox />
    </div>
  );
}
