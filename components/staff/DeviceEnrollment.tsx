'use client';

// DEV-2/SHL — "This counter". Shown at /staff/settings/counter (SET-1 —
// formerly /staff/device, still a redirect for old links), reachable from
// the Settings sidebar/pill nav and the "Settings" tab in the staff header.
//
// Desktop-only, like PrinterSettings: the whole point is a FACT ABOUT THE
// MACHINE the browser is running on, and a plain browser tab has no
// meaningful "this machine" to enrol — same bridge-check-after-mount pattern
// as PrinterSettings.tsx (SSR has no `window`, so the check runs after mount
// and renders nothing until it has).
//
// Why there's a "sign in as the owner" step here, and not just an isOwner
// check: /staff/login only ever establishes a 'staff'-audience session
// (lib/auth/audience.ts) — an owner account is refused there by design (that
// restriction is what stops a counter tablet's bookmark from opening
// payroll). So an owner session can never simply *already be* the one
// signed in on this screen. This form calls the exact same
// POST /api/auth/login the owner's own login page uses, with
// audience: 'owner' — same credential check, same door, just reachable from
// this screen instead of a page the app window can no longer navigate to.
//
// An owner session must never be left sitting on this shared counter
// machine, though: `/api/owner/*` calls would keep working from here (they
// aren't gated by which page the app window can navigate to), and any order
// or settle in the meantime would attribute to the owner instead of whoever
// is actually behind the till. So every path that creates or finds an owner
// session here (`isOwner`, the prop passed down from the Server Component
// page — the one server-side signal this screen trusts for that, never
// anything client-reported) ends with `signOutOwner()`: after a successful
// enrol, automatically; otherwise, behind an explicit "Sign out owner"
// button.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useSurfaceHref } from '@/components/SurfaceLink';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { withEnrolledNotice } from '@/lib/staff/deviceEnrollment';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

const MAX_NAME_LEN = 40;

interface DeviceInfo {
  name: string;
  enrolled_at: string;
}

/** Ends whatever session is signed in here and sends the browser back to
 * staff sign-in — the one exit every owner-signed-in state on this screen
 * shares. `notice: true` (post-enrol only) adds the query param that shows
 * "Counter enrolled. Staff can sign in now." on that page. `/api/auth/logout`
 * already uses `{ scope: 'local' }` (Phase 7: independent logins), so this
 * only ever ends the session on THIS device, never anywhere else. */
function useSignOutOwner(): (opts?: { notice?: boolean }) => Promise<void> {
  const router = useRouter();
  const toHref = useSurfaceHref();
  return useCallback(
    async (opts) => {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {
        // Best-effort — still leave the owner-signed-in screen either way.
      }
      const staffLogin = toHref('/staff/login');
      router.push(opts?.notice ? withEnrolledNotice(staffLogin) : staffLogin);
      router.refresh();
    },
    [router, toHref],
  );
}

function SignOutOwnerButton({ signingOut, onSignOut }: { signingOut: boolean; onSignOut: () => void }) {
  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="text-xs text-muted">Sign out before handing the counter back to staff.</p>
      <Button variant="secondary" size="sm" className="mt-2" loading={signingOut} onClick={onSignOut}>
        Sign out owner
      </Button>
    </div>
  );
}

export function DeviceEnrollment({
  isOwner,
  registryAvailable,
  device: initialDevice,
}: {
  isOwner: boolean;
  registryAvailable: boolean;
  device: DeviceInfo | null;
}) {
  const [checked, setChecked] = useState(false);
  const [inApp, setInApp] = useState(false);

  useEffect(() => {
    setInApp(getDesktopBridge() !== null);
    setChecked(true);
  }, []);

  if (!checked) return null;

  if (!inApp) return <BrowserNote />;

  if (!registryAvailable) {
    return (
      <Panel>
        <p className="text-sm text-charcoal">
          Device setup isn&apos;t available yet (database update pending).
        </p>
      </Panel>
    );
  }

  if (initialDevice) return <EnrolledPanel device={initialDevice} isOwner={isOwner} />;

  return isOwner ? <EnrollForm /> : <AskOwnerPanel />;
}

function Panel({ children }: { children: React.ReactNode }) {
  return <section className="rounded-md border border-line bg-cream p-5">{children}</section>;
}

/** Shown in a plain browser tab — there's no bridge, so no "this machine" to
 * name. PrinterSettings' NoBridgePanel is the fuller version of this same
 * explanation; this stays short since the page's real job here is enrolment,
 * not re-explaining the app. */
function BrowserNote() {
  return (
    <Panel>
      <p className="text-sm text-charcoal">
        Trusted counters are set up in the HIOC POS app, not in a browser tab.
      </p>
      <p className="mt-2 text-sm text-muted">
        Open the HIOC POS app on this machine, sign in, and come back to Printers → This counter.
      </p>
    </Panel>
  );
}

/** `isOwner` here is the case from the fix: already enrolled, but the owner
 * (having signed in to check, or having just enrolled from elsewhere) is
 * still the one signed in on this screen. Shows the sign-out escape hatch;
 * a staff session sees the plain enrolled state with nothing extra. */
function EnrolledPanel({ device, isOwner }: { device: DeviceInfo; isOwner?: boolean }) {
  const signOutOwner = useSignOutOwner();
  const [signingOut, setSigningOut] = useState(false);
  const enrolledDate = new Date(device.enrolled_at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  async function handleSignOut() {
    setSigningOut(true);
    await signOutOwner();
  }

  return (
    <Panel>
      <div className="flex items-center gap-2">
        <Badge variant="success">Trusted counter</Badge>
      </div>
      <p className="mt-3 text-lg font-bold text-charcoal">{device.name}</p>
      <p className="text-sm text-muted">Enrolled {enrolledDate}</p>
      {isOwner ? <SignOutOwnerButton signingOut={signingOut} onSignOut={handleSignOut} /> : null}
    </Panel>
  );
}

/** Not enrolled, not the owner — the common case. Every staffer sees this;
 * the owner sign-in below is a deliberately quiet, collapsed escape hatch
 * rather than a form sitting open on the counter's everyday screen. */
function AskOwnerPanel() {
  const [showOwnerSignIn, setShowOwnerSignIn] = useState(false);

  return (
    <Panel>
      <p className="text-sm text-charcoal">This counter isn&apos;t enrolled yet.</p>
      <p className="mt-2 text-sm text-muted">Ask the owner to enrol this counter from this app.</p>

      {showOwnerSignIn ? (
        <div className="mt-4 border-t border-line pt-4">
          <OwnerSignInForm onCancel={() => setShowOwnerSignIn(false)} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowOwnerSignIn(true)}
          className="mt-4 text-sm font-bold text-tan underline decoration-tan/50 underline-offset-2 hover:text-tan-dark"
        >
          Owner: sign in to enrol this counter
        </button>
      )}
    </Panel>
  );
}

/**
 * A dedicated owner-audience sign-in, local to this screen — see the file
 * comment for why /staff/login can't be reused for this. Reuses
 * POST /api/auth/login exactly as the owner's own login page calls it.
 */
function OwnerSignInForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, audience: 'owner' }),
      });
      if (res.ok) {
        // Re-runs the server check with the new session — this screen then
        // renders the Enrol form (or the "already enrolled" panel) instead
        // of this sign-in step.
        router.refresh();
        return;
      }
      if (res.status === 401) {
        setError('Invalid email or password.');
      } else {
        const data = await res.json().catch(() => ({ error: 'Sign-in failed' }));
        setError(data.error ?? 'Sign-in failed');
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        This signs the owner in on this counter, replacing the session currently signed in here. The owner
        should sign out again (below, once enrolled) before handing the counter back to staff.
      </p>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
      <Input
        label="Owner email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Input
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" loading={submitting}>
          Sign in
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Owner, not yet enrolled: name it and enrol. Enrolling always enrols the
 * machine making the request (POST /api/owner/devices), exactly as
 * DeviceManager on /owner/devices does — reused verbatim, not duplicated.
 * On success the owner session is signed out immediately (see the file
 * comment) rather than showing a local "enrolled" success state — the
 * banner on /staff/login says it instead, so there's nothing to skip past. */
function EnrollForm() {
  const signOutOwner = useSignOutOwner();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name this device so you can recognise it later.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/owner/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Could not enrol this counter.');
        return;
      }
      // Enrolled — end the owner session on this shared counter right away
      // rather than leaving it signed in with owner authority. The
      // /staff/login page the owner lands on explains what just happened.
      setSigningOut(true);
      await signOutOwner({ notice: true });
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel>
      <p className="text-sm text-charcoal">This counter isn&apos;t enrolled yet.</p>
      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
        {error ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {error}
          </p>
        ) : null}
        <Input
          label="Name this counter"
          placeholder="Counter 1"
          maxLength={MAX_NAME_LEN}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" loading={submitting || signingOut}>
          Enrol this counter
        </Button>
      </form>
      <SignOutOwnerButton
        signingOut={signingOut}
        onSignOut={async () => {
          setSigningOut(true);
          await signOutOwner();
        }}
      />
    </Panel>
  );
}
