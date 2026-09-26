import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCounterActor } from '@/lib/api/auth';
import { getEnrolledDevice } from '@/lib/api/device';
import { operatorFeatureConfigured } from '@/lib/api/operator';
import { flags } from '@/lib/flags';
import { StaffHeader } from '@/components/staff/StaffHeader';
import { StaffShell } from '@/components/staff/StaffShell';
import { StaffPinOverlay } from '@/components/staff/pin/StaffPinOverlay';
import { LockScreen } from '@/components/staff/pin/LockScreen';

// DEV-1 — the install offer belongs to this surface and no other. The manifest
// describes the POS (app/pos.webmanifest/route.ts), so linking it from the
// customer site would offer a cafe customer the counter's app; declaring it here
// covers /staff/**, which includes /staff/login on purpose — a counter machine
// should be installable before anyone signs in on it.
export const metadata: Metadata = {
  manifest: '/pos.webmanifest',
};

/**
 * Nested layout for everything under /staff/**. Intentionally does NOT
 * render SiteHeader/SiteFooter or any cart UI (staff pages are a separate
 * "backstage" surface). middleware.ts is the primary auth+role gate; this
 * server-side check via getCounterActor() (session + profiles.role ===
 * 'staff' — PIN-3: OR an enrolled device's unlocked operator) is the
 * belt-and-suspenders second layer the spec calls for. /staff/login is
 * excluded from both this check and the StaffHeader chrome, identified via
 * the `x-pathname` header middleware forwards (Server Component layouts
 * have no direct access to the URL).
 */
export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = headers().get('x-pathname') ?? '';
  const isLoginPage = pathname.startsWith('/staff/login');
  // Reached from an emailed link before the staffer has any session (like
  // /staff/login itself) — docs/PHASE-5-STAFF-ACCOUNTS.md, "Password emails".
  const isResetPasswordPage = pathname.startsWith('/staff/reset-password');

  if (isLoginPage || isResetPasswordPage) {
    return <>{children}</>;
  }

  const actor = await getCounterActor();
  // PIN-2/3: the flag AND the secret must both check out — with either one
  // off/missing/short, no lock screen and no overlay ever mount, matching
  // the same guard operatorFeatureConfigured() applies to the API routes
  // themselves (lib/api/operator.ts). Computed once so both branches below
  // agree; getEnrolledDevice() still re-verifies against the database either
  // way (D-3), this only decides whether to ask it at all.
  const pinEligible = flags.pinSwitch && operatorFeatureConfigured();

  if (!actor) {
    // PIN-2: middleware.ts let a session-less request through to here for
    // exactly one reason — an enrolled, unrevoked device with the flag AND
    // secret both good. getEnrolledDevice() re-verifies against the database
    // (middleware's cheap cookie-presence check is never the last word,
    // D-3): only a REAL device gets the lock screen; anything else — flag
    // off, secret missing, no device, a revoked device, a personal phone's
    // plain browser tab — redirects to classic login exactly as this always
    // has.
    const device = pinEligible ? await getEnrolledDevice() : null;
    if (device) {
      return (
        <div className="min-h-screen bg-charcoal">
          <LockScreen deviceName={device.name} fullScreen />
        </div>
      );
    }
    redirect('/staff/login');
  }

  const { user, role, via } = actor;
  const displayName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    '';

  // PIN-2: the lock/switch overlay mounts only on an enrolled device with the
  // flag AND secret both good — StaffPinOverlay itself further gates on
  // being inside the desktop app (getDesktopBridge()), so a personal phone or
  // a plain browser tab on this same machine still gets the plain shell below.
  const device = pinEligible ? await getEnrolledDevice() : null;

  if (device) {
    return (
      <StaffShell>
        <div className="min-h-screen bg-cream">
          <StaffPinOverlay
            userEmail={user.email ?? ''}
            userName={displayName}
            role={role}
            device={{ id: device.id, name: device.name }}
            initialOperatorName={via === 'device' ? displayName || user.email || null : null}
          >
            {children}
          </StaffPinOverlay>
        </div>
      </StaffShell>
    );
  }

  return (
    <StaffShell>
      <div className="min-h-screen bg-cream">
        <StaffHeader userEmail={user.email ?? ''} userName={displayName} role={role} />
        <main>{children}</main>
      </div>
    </StaffShell>
  );
}
