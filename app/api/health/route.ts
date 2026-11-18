import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { captureError } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

// GET /api/health — public. Read by the uptime watch
// (.github/workflows/uptime-watch.yml) and by the incident manager
// (.claude/skills/incident-manager/SKILL.md). It answers two questions: is this
// deployment serving requests, and can it reach the database.
//
// /api/store-settings cannot stand in for it: that route falls back to default
// settings when its database read fails, so it answers 200 through a database
// outage.
//
// The anon client is deliberate. store_settings is readable by anon under RLS,
// and a public route has no reason to hold the service-role key. The body
// carries only the status and the commit being served. The database's own error
// text goes to the server log, never to the caller.

const DB_TIMEOUT_MS = 4000;

async function databaseReachable(): Promise<boolean> {
  try {
    const { error } = await createServerSupabaseClient()
      .from('store_settings')
      .select('id')
      .limit(1)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (error) {
      captureError(new Error(error.message), { where: 'health-route' });
      return false;
    }
    return true;
  } catch (err) {
    captureError(err, { where: 'health-route' });
    return false;
  }
}

export async function GET() {
  const dbOk = await databaseReachable();
  const status = {
    ok: dbOk,
    db: dbOk ? 'ok' : 'unreachable',
    // Which build answered. After a rollback this is how a reader confirms that
    // production is serving the older commit. The repository is public, so a
    // commit id gives nothing away.
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    checkedAt: new Date().toISOString(),
  };
  return NextResponse.json(dbOk ? status : { ...status, error: 'Database check failed' }, {
    status: dbOk ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
