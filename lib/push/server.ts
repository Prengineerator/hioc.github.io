import 'server-only';
import webpush from 'web-push';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { assertOk } from '@/lib/marketing/server/repo';
import type { PushMessage } from './validate';

// Server-side sending. Route handlers only (uses the service-role client).

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function vapidConfig(): VapidConfig | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export const NOT_CONFIGURED_MESSAGE =
  'Phone notifications are not set up yet. Add NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in Vercel, then redeploy.';

export interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendOutcome {
  delivered: number;
  failed: number;
  removed: number;
  skipped: number;
}

const BATCH = 20;
const CHUNK = 100;
/** One push service answering slowly must not hold a batch for long. */
export const SEND_TIMEOUT_MS = 5_000;
/** Stop starting new batches after this long (the routes allow 60 s). */
export const SEND_BUDGET_MS = 40_000;

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/** Every subscription (optionally one user's), paged past PostgREST's 1000-row cap. */
export async function loadSubscriptions(admin: Admin, userId?: string): Promise<SubscriptionRow[]> {
  const out: SubscriptionRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from('push_subscriptions').select('id, endpoint, p256dh, auth').order('id', { ascending: true }).range(from, from + 999);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    assertOk('push_subscriptions read', error);
    const rows = (data ?? []) as SubscriptionRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const chunks = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * Sends to every row in small parallel batches. A 404/410 from the push service
 * means the phone is gone: the row is deleted. Anything else counts as failed and
 * the row stays. Successful rows get last_success_at. If the time budget runs
 * out, the rest are not tried and are counted as skipped (and failed).
 *
 * `out` is updated as it goes, so a caller still has honest counts if this throws.
 */
export async function sendToSubscriptions(
  admin: Admin,
  subs: SubscriptionRow[],
  message: PushMessage,
  sendId: string,
  cfg: VapidConfig,
  send: typeof webpush.sendNotification = webpush.sendNotification,
  out: SendOutcome = { delivered: 0, failed: 0, removed: 0, skipped: 0 },
  budgetMs: number = SEND_BUDGET_MS,
): Promise<SendOutcome> {
  const payload = JSON.stringify({ title: message.title, body: message.body, url: message.url, sendId });
  const options = {
    TTL: 60 * 60 * 24,
    timeout: SEND_TIMEOUT_MS,
    vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
  };
  const okIds: string[] = [];
  const goneIds: string[] = [];
  const startedAt = Date.now();

  try {
    const batches = chunks(subs, BATCH);
    for (let b = 0; b < batches.length; b++) {
      if (Date.now() - startedAt > budgetMs) {
        const left = batches.slice(b).reduce((n, x) => n + x.length, 0);
        out.skipped += left;
        out.failed += left;
        break;
      }
      const batch = batches[b];
      const results = await Promise.allSettled(
        batch.map((s) => send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options)),
      );
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          okIds.push(batch[i].id);
          out.delivered += 1;
          return;
        }
        out.failed += 1;
        const status = (r.reason as { statusCode?: number } | undefined)?.statusCode;
        if (status === 404 || status === 410) {
          goneIds.push(batch[i].id);
          out.removed += 1;
        }
      });
    }
  } finally {
    for (const ids of chunks(goneIds, CHUNK)) {
      const { error } = await admin.from('push_subscriptions').delete().in('id', ids);
      if (error) console.error('push cleanup failed', error.message);
    }
    const now = new Date().toISOString();
    for (const ids of chunks(okIds, CHUNK)) {
      const { error } = await admin.from('push_subscriptions').update({ last_success_at: now }).in('id', ids);
      if (error) console.error('push last_success_at failed', error.message);
    }
  }
  return out;
}

/** Sends, and ALWAYS writes the counts on the push_sends row, even if the send throws. */
export async function sendAndRecord(admin: Admin, subs: SubscriptionRow[], message: PushMessage, sendId: string, cfg: VapidConfig): Promise<SendOutcome> {
  const out: SendOutcome = { delivered: 0, failed: 0, removed: 0, skipped: 0 };
  try {
    return await sendToSubscriptions(admin, subs, message, sendId, cfg, webpush.sendNotification, out);
  } finally {
    const { error } = await admin.from('push_sends').update({ delivered: out.delivered, failed: out.failed }).eq('id', sendId);
    if (error) console.error('push_sends update failed', error.message);
  }
}
