// Feature flags (XC-045) — lets us dark-launch the owner surface and toggle
// realtime/notifications without a redeploy dependency. Read from env with
// safe defaults; a flag is "on" unless explicitly set to 'false'/'0'/'off'.
//
// NEXT_PUBLIC_* flags are readable on the client (menu/checkout/status);
// server-only flags are read in Route Handlers.

function boolEnv(raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined || raw === '') return dflt;
  const v = raw.trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
  if (v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
  return dflt;
}

export const flags = {
  // Owner dashboard dark-launch. Default ON so the surface is reachable by an
  // owner account; set NEXT_PUBLIC_FLAG_OWNER_DASHBOARD=false to hide it.
  ownerDashboard: boolEnv(process.env.NEXT_PUBLIC_FLAG_OWNER_DASHBOARD, true),
  // Realtime push (staff board + customer status). When off, surfaces fall
  // back to pure polling — the same path the poll-fallback uses on socket loss.
  realtime: boolEnv(process.env.NEXT_PUBLIC_FLAG_REALTIME, true),
  // Notifications engine. When off, transitions still record events but no
  // send is attempted/logged (useful before a provider is chosen).
  notifications: boolEnv(process.env.FLAG_NOTIFICATIONS, true),
} as const;

export type FeatureFlags = typeof flags;
