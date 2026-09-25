'use client';

// Owner feedback thread view (/owner/feedback/[id]): order + rating context,
// the chat history, and the controls to work the thread — status, notes,
// mark read, and the reply box (free-text within Meta's 24h window; a resend
// action when it's closed).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { StarRating } from '@/components/reviews/StarRating';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { FeedbackMessage, FeedbackRequest, FeedbackThreadStatus } from '@/lib/types';

interface OrderLite {
  order_number: number;
  total_inr: number | null;
  subtotal_inr: number;
  order_items: { id: string; name_snapshot: string; quantity: number; voided: boolean }[];
}

interface ThreadData {
  request: FeedbackRequest;
  order: OrderLite | null;
  messages: FeedbackMessage[];
  canReplyFreeform: boolean;
}

const STATUS_OPTIONS: { value: FeedbackThreadStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
];

export function FeedbackThread({ requestId }: { requestId: string }) {
  const [data, setData] = useState<ThreadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [resending, setResending] = useState(false);
  const [toast, setToast] = useState('');
  const markedRead = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/owner/feedback/${requestId}`);
    const d = await res.json();
    if (res.ok) {
      setData(d);
      setNotes(d.request.owner_notes ?? '');
    }
    setLoading(false);
    return d;
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  // Mark the thread read once, on open — not on every poll/reload.
  useEffect(() => {
    if (data?.request.unread && !markedRead.current) {
      markedRead.current = true;
      fetch(`/api/owner/feedback/${requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unread: false }),
      }).catch(() => {});
    }
  }, [data, requestId]);

  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/owner/feedback/${requestId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const d = await res.json();
      setData((prev) => (prev ? { ...prev, request: d.request } : prev));
    }
  }

  async function saveNotes() {
    setSavingNotes(true);
    try {
      await patch({ owner_notes: notes });
    } finally {
      setSavingNotes(false);
    }
  }

  async function sendReply() {
    if (!reply.trim()) return;
    setSending(true);
    setToast('');
    try {
      const res = await fetch(`/api/owner/feedback/${requestId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: reply.trim() }),
      });
      if (res.ok) {
        setReply('');
        await load();
      } else {
        const d = await res.json().catch(() => ({}));
        setToast(d.error ?? 'Send failed');
      }
    } finally {
      setSending(false);
    }
  }

  async function resendTemplate() {
    setResending(true);
    setToast('');
    try {
      const res = await fetch(`/api/owner/feedback/${requestId}/resend`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      setToast(res.ok ? 'Feedback template re-sent.' : (d.error ?? 'Resend failed'));
      if (res.ok) await load();
    } finally {
      setResending(false);
    }
  }

  if (loading) return <Spinner label="Loading thread…" />;
  if (!data) return <p className="py-8 text-center text-sm text-muted">Thread not found.</p>;

  const { request, order, messages, canReplyFreeform } = data;

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-charcoal">{request.customer_name || request.phone}</p>
            <p className="text-xs text-muted">{request.phone}</p>
          </div>
          {order ? (
            <div className="text-right text-xs text-muted">
              <p className="font-bold text-charcoal">{formatOrderNumber(order.order_number)}</p>
              <p>₹{order.total_inr ?? order.subtotal_inr}</p>
            </div>
          ) : null}
        </div>
        <div className="mt-3 flex items-center gap-3">
          {request.rating ? (
            <StarRating value={request.rating} size="sm" />
          ) : (
            <span className="text-xs text-muted">No rating yet ({request.status})</span>
          )}
          {request.rating_source ? (
            <span className="text-xs text-muted">via {request.rating_source === 'whatsapp_button' ? 'WhatsApp' : 'web form'}</span>
          ) : null}
        </div>
        {order && order.order_items.filter((i) => !i.voided).length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
            {order.order_items.filter((i) => !i.voided).map((item) => (
              <li key={item.id}>
                {item.name_snapshot}
                {item.quantity > 1 ? ` ×${item.quantity}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-cream p-4 shadow-sm">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-charcoal">Status</span>
          <select
            value={request.thread_status}
            onChange={(e) => patch({ thread_status: e.target.value })}
            className="rounded-md border border-line bg-cream p-1.5 text-sm"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Internal notes</h2>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Notes only staff can see…" />
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={saveNotes} loading={savingNotes}>
            Save notes
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">Conversation</h2>
        {messages.length === 0 ? (
          <p className="text-sm text-muted">No messages yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((m) => (
              <li key={m.id} className={'flex ' + (m.direction === 'out' ? 'justify-end' : 'justify-start')}>
                <div
                  className={
                    'max-w-[80%] rounded-md px-3 py-2 text-sm ' +
                    (m.direction === 'out' ? 'bg-tan text-cream' : 'bg-surface text-charcoal')
                  }
                >
                  <p>{m.body || <span className="italic opacity-70">(no text)</span>}</p>
                  <p className="mt-1 text-[10px] opacity-70">{new Date(m.created_at).toLocaleString('en-IN')}</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 border-t border-line pt-3">
          {canReplyFreeform ? (
            <div className="flex flex-col gap-2">
              <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Reply on WhatsApp…" />
              <div>
                <Button size="sm" onClick={sendReply} loading={sending} disabled={!reply.trim()}>
                  Send
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted">
                Outside WhatsApp&apos;s 24-hour reply window — a free-text reply isn&apos;t allowed until the customer
                messages again. You can nudge them with the feedback template instead.
              </p>
              <div>
                <Button size="sm" variant="secondary" onClick={resendTemplate} loading={resending}>
                  Resend feedback template
                </Button>
              </div>
            </div>
          )}
          {toast ? <p className="mt-2 text-xs font-semibold text-charcoal">{toast}</p> : null}
        </div>
      </div>
    </div>
  );
}
