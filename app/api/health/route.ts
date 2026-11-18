import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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
// The answer must not depend on who is asking. The database read is therefore
// made with a client built here from the public anon key alone: no cookies, no
// request headers. The usual server client (createServerSupabaseClient) forwards
// the caller's session cookie, which would let anyone make this route answer 503
// for themselves by sending a forged one. store_settings is readable by anon
// under RLS. The service-role key is not used.
//
// The body carries only the status and the commit being served. The database's
// own error text goes to the server log, never to the caller.

const DB_TIMEOUT_MS = 4000;

// A failing database makes every health check fail, from the watch and from
// anyone else who calls this route. One report a minute per server instance is
// enough to say so; more would bury the logs the incident manager reads.
const REPORT_EVERY_MS = 60_000;
let lastReportedAt = 0;

function reportFailure(err: unknown): void {
  const now = Date.now();
  if (now - lastReportedAt < REPORT_EVERY_MS) return;
  lastReportedAt = now;
  captureError(err, { where: 'health-route' });
}

// Next.js caches GET requests made through its patched fetch, including the ones
// supabase-js makes to PostgREST (see lib/supabase-server.ts). A cached "ok"
// here would report a dead database as healthy, so every read is forced live.
const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: 'no-store' });

function anonClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: noStoreFetch },
    },
  );
}

async function databaseReachable(): Promise<boolean> {
  try {
    const { error } = await anonClient()
      .from('store_settings')
      .select('id')
      .limit(1)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (error) {
      reportFailure(new Error(error.message));
      return false;
    }
    return true;
  } catch (err) {
    reportFailure(err);
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
