'use client';

// PIN-2 — mounted from app/staff/layout.tsx whenever the flag is on AND this
// machine is an enrolled device AND there is already someone in (a classic
// session, or a prior PIN unlock). It:
//  - shows the current operator + a Switch/Lock action in StaffHeader;
//  - auto-locks after an idle period, WITHOUT unmounting `children` (spec E5:
//    an in-progress cart survives a lock/switch — it's client state sitting
//    right there underneath the overlay);
//  - is a complete no-op — plain StaffHeader + children, nothing extra
//    rendered or fetched — the moment this ISN'T the desktop app, so a
//    personal phone or a plain browser tab on this same enrolled machine
//    never sees any of it (checked client-side after mount, same pattern as
//    components/staff/DeviceEnrollment.tsx / PrinterSettings.tsx: SSR has no
//    `window`, so nothing renders until the check has run once).
//
// Known, deliberate limitation: when the current session is a CLASSIC one
// (`via === 'session'` from the server) rather than a PIN operator — e.g. the
// owner briefly signed in to check something — "Lock" only clears the
// operator cookie and shows this overlay; it does not and cannot suspend the
// classic Supabase session underneath, so a request issued directly against
// the API (not through this UI) would still succeed. That is out of scope for
// a PIN feature: a classic session belongs to the device-enrollment flow
// signing itself out afterwards (app/staff/settings/counter/page.tsx,
// formerly app/staff/device/page.tsx), not to this
// overlay pretending it can revoke a login it didn't issue.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { StaffHeader } from '@/components/staff/StaffHeader';
import { LockScreen } from './LockScreen';

/** LCK-1: 15 minutes. D6-7's original 2 minutes locked the counter mid-shift
 * — a barista making a round of drinks, or staff watching the board without
 * touching it, came back to the PIN screen every time. The operator cookie
 * still expires after 12h idle (lib/api/operatorCookie.ts), and "Lock" in the
 * header locks at once. A per-device override would live in DEV-3's
 * device-settings columns. */
const IDLE_MS = 15 * 60 * 1000;

export function StaffPinOverlay({
  userEmail,
  userName,
  role,
  device,
  initialOperatorName,
  children,
}: {
  userEmail: string;
  userName: string;
  role: string;
  device: { id: string; name: string };
  /** The operator's display name when the server resolved this request via
   * the device+PIN path; null for a classic session (see file comment). */
  initialOperatorName: string | null;
  children: React.ReactNode;
}) {
  const [checked, setChecked] = useState(false);
  const [inApp, setInApp] = useState(false);
  const [locked, setLocked] = useState(false);
  const [operatorName, setOperatorName] = useState(initialOperatorName);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setInApp(getDesktopBridge() !== null);
    setChecked(true);
  }, []);

  const resetIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setLocked(true), IDLE_MS);
  }, []);

  useEffect(() => {
    if (!inApp || locked) return;
    resetIdle();
    // wheel: scrolling the board with a mouse is activity too.
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((e) => window.addEventListener(e, resetIdle));
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      events.forEach((e) => window.removeEventListener(e, resetIdle));
    };
  }, [inApp, locked, resetIdle]);

  async function handleLock() {
    setLocked(true);
    try {
      await fetch('/api/device/operator', { method: 'DELETE' });
    } catch {
      // Locking the SCREEN must not depend on the network — the overlay is
      // already up either way, blocking taps.
    }
  }

  function handleUnlocked(name: string) {
    setOperatorName(name);
    setLocked(false);
  }

  if (!checked || !inApp) {
    return (
      <>
        <StaffHeader userEmail={userEmail} userName={userName} role={role} />
        <main>{children}</main>
      </>
    );
  }

  return (
    <>
      <StaffHeader
        userEmail={userEmail}
        userName={operatorName || userName}
        role={role}
        pinControls={{ label: operatorName ? 'Switch' : 'Lock', onLock: handleLock }}
      />
      <main>{children}</main>
      {locked ? <LockScreen deviceName={device.name} onUnlocked={handleUnlocked} /> : null}
    </>
  );
}
