import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { notFound, unauthorized } from '@/lib/api/http';
import { flags } from '@/lib/flags';
import { ownerRoute } from '@/lib/marketing/server/http';
import { assertOk } from '@/lib/marketing/server/repo';
import { vapidConfig } from '@/lib/push/server';
import { istDateIso } from '@/lib/api/date';
import type { PushSendRow, PushSummary } from '@/lib/push/types';

export const dynamic = 'force-dynamic';

// GET /api/owner/marketing/push — the Push tab's numbers: signed-up customers and
// phones, the owner's own phones, whether today's broadcast is used, and the
// recent sends. OWNER ONLY. 404 while the webPush flag is off.
export async function GET() {
  if (!flags.webPush) return notFound();
  // Access gate (SECURITY-PLAYBOOK C-3): owner session only, checked before the
  // service-role client is created. ownerRoute re-checks and maps failures.
  if (!(await getOwnerUser())) return unauthorized();
  return ownerRoute(async (owner) => {
    const admin = createAdminSupabaseClient();

    const userIds = new Set<string>();
    let devices = 0;
    let own = 0;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from('push_subscriptions').select('user_id').order('id', { ascending: true }).range(from, from + 999);
      assertOk('push_subscriptions read', error);
      const rows = (data ?? []) as { user_id: string }[];
      for (const r of rows) {
        devices += 1;
        userIds.add(r.user_id);
        if (r.user_id === owner.id) own += 1;
      }
      if (rows.length < 1000) break;
    }

    const recentRes = await admin
      .from('push_sends')
      .select('id, title, body, url, kind, device_count, delivered, failed, clicked, created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    assertOk('push_sends read', recentRes.error);

    const today = await admin.from('push_sends').select('id', { count: 'exact', head: true }).eq('kind', 'broadcast').eq('sent_on', istDateIso());
    assertOk('push_sends read', today.error);

    return NextResponse.json({
      configured: vapidConfig() !== null,
      customers: userIds.size,
      devices,
      own_devices: own,
      sent_today: (today.count ?? 0) > 0,
      recent: (recentRes.data ?? []) as PushSendRow[],
    } satisfies PushSummary);
  });
}
